// Commands run directly inside the existing Jenkins node/container.
def workspaceStarted = false
// main's workspace is the shared dependency source: kept between builds, and its node_modules seeds every other build.
// Every other build (pull requests, tags) runs in a throwaway workspace, emptied before checkout and deleted at the end.
// The plain (non-multibranch) job has no BRANCH_NAME and keeps its own workspace like main.
def keepsWorkspace() {
    return !env.BRANCH_NAME || env.BRANCH_NAME == 'main'
}
// True when the cron trigger started this build.
def isNightly() {
    return !currentBuild.getBuildCauses('hudson.triggers.TimerTrigger$TimerTriggerCause').isEmpty()
}
// A release: a build of a pushed tag like v1.2.3 (multibranch job with tag discovery).
def isRelease() {
    return env.TAG_NAME ==~ /v\d+\.\d+\.\d+/ || isButtonRelease()
}
// A release started from Jenkins: Build with Parameters on main with RELEASE = patch, minor or major.
def isButtonRelease() {
    return env.BRANCH_NAME == 'main' && (params.RELEASE ?: 'none') in ['patch', 'minor', 'major']
}
// Shows this build on the commit in GitHub (✓ / ✗ / pending), using the job's GitHub credential.
// Best effort: a GitHub outage or a token without status rights never fails the build.
def githubStatus(String state, String description) {
    if (!env.GIT_COMMIT) return
    withCredentials([usernamePassword(credentialsId: 'dcc58858-b705-437a-adac-d64dd39c12a3',
            usernameVariable: 'GH_USER', passwordVariable: 'GH_TOKEN')]) {
        withEnv(["GH_STATE=${state}", "GH_DESC=${description}"]) {
            sh '''
                code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
                    -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \
                    "https://api.github.com/repos/janithPriyankara/tablight/statuses/$GIT_COMMIT" \
                    -d "{\\"state\\":\\"$GH_STATE\\",\\"context\\":\\"jenkins/tablight\\",\\"description\\":\\"$GH_DESC\\",\\"target_url\\":\\"$BUILD_URL\\"}" || true)
                echo "GitHub commit status $GH_STATE: HTTP $code"
            '''
        }
    }
}

pipeline {
    agent any
    tools {
        nodejs 'nodejs22.23.5'
    }
    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
        timeout(time: 60, unit: 'MINUTES')
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '5'))
    }
    triggers {
        // Pushes, PRs and tags arrive through the multibranch job's GitHub webhook (/github-webhook/).
        // Nightly, main only: full browser suite and the 200-tab performance check.
        cron(env.BRANCH_NAME == 'main' ? 'H 2 * * *' : '')
    }
    parameters {
        choice(name: 'RELEASE', choices: ['none', 'patch', 'minor', 'major'],
            description: 'main only: run every check, bump the version (patch 1.0.1→1.0.2, minor →1.1.0, major →2.0.0), push the commit and tag, and publish a GitHub release.')
        booleanParam(name: 'RUN_QUALITY_TESTS', defaultValue: false,
            description: 'Run model/classification quality tests (requires extra CPU and memory).')
        booleanParam(name: 'RUN_E2E_TESTS', defaultValue: false,
            description: 'Download Chromium and test the extension; requires Chromium Linux libraries on this node.')
        string(name: 'PERF_TABS', defaultValue: '100',
            description: 'Tabs opened by the @perf test. The nightly build uses 200 (500 crashes Chromium on this host).')
        string(name: 'E2E_WORKERS', defaultValue: '2',
            description: 'How many browser test files run at once (each starts its own Chromium). The 500-tab @perf test always runs alone afterwards.')
    }
    environment {
        CI = 'true'
        npm_config_cache = '/tmp/tablight-npm-cache'
        PLAYWRIGHT_BROWSERS_PATH = '/tmp/tablight-browsers'
        MODEL_CACHE = '/tmp/tablight-model-cache'
        PLAYWRIGHT_JUNIT_OUTPUT_FILE = 'reports/e2e.xml'
    }
    stages {
        stage('Checkout') {
            steps {
                script {
                    // A throwaway workspace starts empty, even if an earlier build of it was killed before cleanup.
                    if (!keepsWorkspace()) deleteDir()
                    workspaceStarted = true
                    env.GIT_COMMIT = checkout(scm).GIT_COMMIT
                    githubStatus('pending', "Build #${env.BUILD_NUMBER} running")
                }
                // Prevent old ZIPs, reports or downloaded assets from masking a failure: remove everything
                // git does not track, except node_modules (Install dependencies decides whether it is current).
                sh 'git clean -ffdx -e node_modules'
                sh 'node --version && npm --version && mkdir -p reports'
            }
        }
        stage('Install dependencies') {
            environment {
                MAIN_WORKSPACE = "${env.JENKINS_HOME}/jobs/tablight-cicd/branches/main/workspace"
            }
            steps {
                // The stamp (lockfile hash + Node version) is written last, after a complete install, so a broken,
                // partial or in-progress install never has one and is never reused.
                //   1. This workspace's node_modules matches the lockfile (main, plain job): nothing to do.
                //   2. Another build whose lockfile matches main's: hard-link main's node_modules (cp -al: no download,
                //      next to no disk, seconds). npm and the build replace files rather than edit them, and the stamp
                //      is removed before it is rewritten, so nothing here can change main's copies. main's stamp is
                //      read again after the copy: if main reinstalled meanwhile, the copy is discarded.
                //   3. Otherwise (a changed lockfile, e.g. a Dependabot PR, or main not installed yet): npm ci.
                sh '''
                    set -eu
                    want="$(sha256sum package-lock.json | cut -c1-64) $(node --version)"
                    stamp() { cat "$1/node_modules/.tablight-lock" 2>/dev/null || true; }
                    if [ -d node_modules ] && [ "$(stamp .)" = "$want" ]; then
                        echo "node_modules is current for this lockfile; skipping npm ci"
                        exit 0
                    fi
                    rm -rf node_modules
                    if [ "$(pwd -P)" != "$(cd "$MAIN_WORKSPACE" 2>/dev/null && pwd -P)" ] && [ "$(stamp "$MAIN_WORKSPACE")" = "$want" ]; then
                        cp -al "$MAIN_WORKSPACE/node_modules" node_modules
                        if [ "$(stamp "$MAIN_WORKSPACE")" = "$want" ]; then
                            rm -rf node_modules/.vite node_modules/.cache
                            rm -f node_modules/.tablight-lock
                            echo "$want" > node_modules/.tablight-lock
                            echo "node_modules hard-linked from main's workspace (same lockfile); skipping npm ci"
                            exit 0
                        fi
                        echo "main's node_modules changed during the copy; installing instead"
                        rm -rf node_modules
                    fi
                    npm ci --no-audit --no-fund
                    rm -f node_modules/.tablight-lock
                    echo "$want" > node_modules/.tablight-lock
                '''
            }
        }
        stage('Supply chain') {
            // Known vulnerabilities at any severity in every dependency manifest: the npm lockfile (shipped and dev)
            // and the build-time Python requirements (fine-tuning; nothing of it ships), from OSV (GitHub advisories,
            // PyPA, npm) and npm's own audit. Plus the registry signature of every installed npm package. OSV-Scanner
            // is a pinned static binary, downloaded once and verified against its release checksums. Reports archived.
            environment {
                OSV_VERSION = '2.7.0'
                TOOLS = '/tmp/tablight-tools'
            }
            steps {
                sh '''
                    set -eu
                    bin="$TOOLS/osv-scanner-$OSV_VERSION"
                    if [ ! -x "$bin" ]; then
                        tmp="$(mktemp -d)"
                        base="https://github.com/google/osv-scanner/releases/download/v$OSV_VERSION"
                        curl -fsSL -o "$tmp/osv-scanner_linux_amd64" "$base/osv-scanner_linux_amd64"
                        curl -fsSL -o "$tmp/sums" "$base/osv-scanner_SHA256SUMS"
                        (cd "$tmp" && grep " osv-scanner_linux_amd64\\$" sums | sha256sum -c -)
                        mkdir -p "$TOOLS" && install -m 0755 "$tmp/osv-scanner_linux_amd64" "$bin"
                        rm -rf "$tmp"
                    fi
                    "$bin" --version
                    set +e
                    "$bin" scan source -L package-lock.json -L scripts/finetune/requirements.txt --format json --output reports/osv.json
                    "$bin" scan source -L package-lock.json -L scripts/finetune/requirements.txt
                    osv=$?
                    npm audit --json > reports/npm-audit.json
                    npm audit --audit-level=low
                    audit=$?
                    npm audit signatures
                    sigs=$?
                    [ "$osv" -eq 0 ] && [ "$audit" -eq 0 ] && [ "$sigs" -eq 0 ]
                '''
            }
        }
        stage('Secret scan') {
            // gitleaks over every commit (so every tracked file, HEAD included; after git clean the rest is
            // node_modules and build output). The pinned release is downloaded once, verified against that release's
            // checksums file, and kept in /tmp. Findings are redacted in the report.
            environment {
                GITLEAKS_VERSION = '8.30.1'
                TOOLS = '/tmp/tablight-tools'
            }
            steps {
                sh '''
                    set -eu
                    bin="$TOOLS/gitleaks-$GITLEAKS_VERSION"
                    if [ ! -x "$bin" ]; then
                        tmp="$(mktemp -d)"
                        base="https://github.com/gitleaks/gitleaks/releases/download/v$GITLEAKS_VERSION"
                        tgz="gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
                        curl -fsSL -o "$tmp/$tgz" "$base/$tgz"
                        curl -fsSL -o "$tmp/sums.txt" "$base/gitleaks_${GITLEAKS_VERSION}_checksums.txt"
                        (cd "$tmp" && grep " $tgz\\$" sums.txt | sha256sum -c -)
                        tar -xzf "$tmp/$tgz" -C "$tmp" gitleaks
                        mkdir -p "$TOOLS" && install -m 0755 "$tmp/gitleaks" "$bin"
                        rm -rf "$tmp"
                    fi
                    "$bin" version
                    "$bin" git --redact --no-banner --exit-code 1 --report-format json --report-path reports/gitleaks.json .
                '''
            }
        }
        // One after another, not side by side: the shared Jenkins host is small, and peak memory matters more than minutes.
        // Lint and type check re-check only what changed since the last build (results kept in /tmp, keyed by content).
        stage('Lint') {
            steps { sh 'npm run lint -- --cache --cache-strategy content --cache-location /tmp/tablight-eslint-cache/' }
        }
        stage('Type check') {
            steps { sh 'npx --no-install tsc --noEmit --incremental --tsBuildInfoFile /tmp/tablight-tsc/tsbuildinfo' }
        }
        stage('Unit tests') {
            steps {
                // --coverage: fails under the thresholds in vitest.config.ts; lcov/cobertura reports land in reports/coverage.
                sh 'npm test -- --coverage --reporter=default --reporter=junit --outputFile.junit=reports/unit.xml'
            }
        }
        stage('Sonar') {
            // Self-hosted SonarQube Community (sonar-project.properties) with the unit coverage; the build waits for the
            // quality gate and fails with it. Community analyzes the main branch only, so it runs on main builds
            // (RELEASE-button releases included) and the plain job, and pull request and tag builds skip it.
            // Needs a Jenkins "Secret text" credential with the id sonar-token; until it exists, ordinary main builds
            // skip with a notice and a release refuses to go out. The scanner JVM is kept small: the host has 4 GB.
            when { expression { keepsWorkspace() } }
            environment {
                SONAR_SCANNER_JAVA_OPTS = '-Xmx512m'
            }
            steps {
                script {
                    try {
                        withCredentials([string(credentialsId: 'sonar-token', variable: 'SONAR_TOKEN')]) {
                            sh 'npx --no-install sonar-scanner-npm -Dsonar.token="$SONAR_TOKEN"'
                        }
                    } catch (org.jenkinsci.plugins.credentialsbinding.impl.CredentialNotFoundException e) {
                        if (isRelease()) error('Sonar: no sonar-token credential; a release needs the Sonar quality gate.')
                        echo 'Sonar: no sonar-token credential yet; skipping (add it to enable the quality gate).'
                    }
                }
            }
        }
        stage('Prepare model assets') {
            steps {
                // model-cache.mjs removes any other model from public/models (only the bundled one may reach
                // dist). The bundled model (MODEL_REVISION `local-…`) is committed, so the cache is neither read
                // nor written for it: prepare:assets only verifies its SHA-256s. A downloaded model's pinned files
                // are kept in $MODEL_CACHE between builds and never copied over files the workspace has.
                sh 'node scripts/model-cache.mjs restore "$MODEL_CACHE"'
                sh 'npm run prepare:assets'
                sh 'node scripts/model-cache.mjs save "$MODEL_CACHE"'
            }
        }
        stage('Quality tests') {
            when { expression { params.RUN_QUALITY_TESTS || isRelease() } }
            steps {
                sh 'npm run test:quality -- --reporter=junit --outputFile.junit=reports/quality.xml'
            }
        }
        stage('Build and package') {
            steps {
                // package runs a fresh build plus the existing release gates, including ZIP size.
                sh 'npm run package'
                // CycloneDX SBOM of the production dependency tree, next to the ZIP.
                sh 'npm run sbom'
            }
        }
        stage('Browser tests') {
            when { expression { params.RUN_E2E_TESTS || isNightly() || isRelease() } }
            environment {
                // Nightly: 200 tabs (500 real tabs crash Chromium on this host, build #30). Releases use the normal
                // size so a release never depends on host memory.
                PERF_TABS = "${isNightly() ? '200' : params.PERF_TABS}"
            }
            steps {
                sh 'npx --no-install playwright install chromium'
                // No root on this shared host: Chromium's system libraries go into a private folder.
                // catchError: a failure marks the build failed but the perf pass still runs.
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    sh "scripts/ci/e2e-no-root.sh --reporter=list,junit --workers=${params.E2E_WORKERS} --grep-invert @perf"
                }
                // 500 real tabs need the host's memory to themselves.
                catchError(buildResult: 'FAILURE', stageResult: 'FAILURE') {
                    withEnv(['PLAYWRIGHT_JUNIT_OUTPUT_FILE=reports/e2e-perf.xml']) {
                        sh 'scripts/ci/e2e-no-root.sh --reporter=list,junit --workers=1 --grep @perf'
                    }
                }
            }
        }
        stage('Archive release') {
            steps {
                archiveArtifacts artifacts: 'release/tablight-*.zip,release/tablight-*.sbom.cdx.json', fingerprint: true
            }
        }
        stage('Bump version') {
            // Button release only, after every check passed: commit the new version and push it with its tag.
            when { expression { isButtonRelease() && currentBuild.currentResult == 'SUCCESS' } }
            steps {
                withCredentials([usernamePassword(credentialsId: 'dcc58858-b705-437a-adac-d64dd39c12a3',
                        usernameVariable: 'GH_USER', passwordVariable: 'GH_TOKEN')]) {
                    sh '''
                        set -eu
                        git config user.name "Jenkins"
                        git config user.email "jenkins@users.noreply.github.com"
                        git checkout -B main
                        npm version "$RELEASE" -m "release %s"
                        # The ZIP was built before the bump; rebuild so its name and manifest carry the new version.
                        npm run package
                        npm run sbom
                        tag="v$(node -p "require('./package.json').version")"
                        url="https://x-access-token:$GH_TOKEN@github.com/janithPriyankara/tablight.git"
                        # Fails (and releases nothing) if main moved on GitHub while this build ran.
                        git push "$url" main "$tag"
                        echo "$tag" > release-tag.txt
                    '''
                }
                archiveArtifacts artifacts: 'release/tablight-*.zip,release/tablight-*.sbom.cdx.json', fingerprint: true
            }
        }
        stage('GitHub release') {
            // Only for a v1.2.3 tag or the RELEASE button, and only when every stage above passed.
            when { expression { isRelease() && currentBuild.currentResult == 'SUCCESS' } }
            steps {
                withCredentials([usernamePassword(credentialsId: 'dcc58858-b705-437a-adac-d64dd39c12a3',
                        usernameVariable: 'GH_USER', passwordVariable: 'GH_TOKEN')]) {
                    sh '''
                        set -eu
                        TAG_NAME="${TAG_NAME:-$(cat release-tag.txt)}"
                        export TAG_NAME
                        version=$(node -p "require('./package.json').version")
                        if [ "v$version" != "$TAG_NAME" ]; then
                            echo "Tag $TAG_NAME does not match package.json version $version; not releasing." >&2
                            exit 1
                        fi
                        zip="release/tablight-$version.zip"
                        api=https://api.github.com/repos/janithPriyankara/tablight
                        auth="Authorization: Bearer $GH_TOKEN"
                        # A button release pushes its tag, which starts a tag build too: whichever comes second
                        # finds the release already there and stops here.
                        if [ "$(curl -s -o /dev/null -w '%{http_code}' -H "$auth" "$api/releases/tags/$TAG_NAME")" = 200 ]; then
                            echo "Release $TAG_NAME already exists; nothing to do."
                            exit 0
                        fi
                        # Notes: the feat/fix/perf commits since the previous version tag (scripts/release-notes.mjs).
                        if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
                            git fetch --quiet --unshallow https://github.com/janithPriyankara/tablight.git
                        fi
                        git fetch --quiet --tags --force https://github.com/janithPriyankara/tablight.git
                        node scripts/release-notes.mjs HEAD --tag "$TAG_NAME" > release-notes.md
                        echo "Release notes:" && cat release-notes.md
                        node -e 'const v = require("./package.json").version; process.stdout.write(JSON.stringify({
                            tag_name: process.env.TAG_NAME, name: "Tablight " + v,
                            body: require("fs").readFileSync("release-notes.md", "utf8") }))' > release-request.json
                        code=$(curl -s -o release.json -w '%{http_code}' -X POST -H "$auth" \\
                            -H "Accept: application/vnd.github+json" "$api/releases" --data @release-request.json || echo curl-failed)
                        if [ "$code" != 201 ]; then
                            echo "Creating the GitHub release failed: HTTP $code" >&2
                            sed -n 1,20p release.json >&2
                            exit 1
                        fi
                        id=$(node -p "require('./release.json').id")
                        page=$(node -p "require('./release.json').html_url")
                        # The ZIP, its CycloneDX SBOM, and SHA-256 sums of both (so a download can be checked).
                        sbom="release/tablight-$version.sbom.cdx.json"
                        (cd release && sha256sum "tablight-$version.zip" "tablight-$version.sbom.cdx.json" > SHA256SUMS)
                        for f in "$zip:application/zip" "$sbom:application/vnd.cyclonedx+json" "release/SHA256SUMS:text/plain"; do
                            path="${f%%:*}"
                            type="${f#*:}"
                            name="$(basename "$path")"
                            code=$(curl -s -o asset.json -w '%{http_code}' -X POST -H "$auth" \\
                                -H "Content-Type: $type" --data-binary "@$path" \\
                                "https://uploads.github.com/repos/janithPriyankara/tablight/releases/$id/assets?name=$name" \\
                                || echo curl-failed)
                            if [ "$code" != 201 ]; then
                                echo "Uploading $path failed: HTTP $code" >&2
                                sed -n 1,20p asset.json >&2
                                exit 1
                            fi
                        done
                        echo "Released: $page"
                    '''
                }
            }
        }
    }
    post {
        always {
            script {
                if (workspaceStarted) {
                    junit testResults: 'reports/*.xml', allowEmptyResults: true
                    archiveArtifacts artifacts: 'reports/**,test-results/**', allowEmptyArchive: true
                } else {
                    echo 'No workspace was started; skipping reports.'
                }
            }
        }
        success { script { githubStatus('success', "Build #${env.BUILD_NUMBER} passed") } }
        unstable { script { githubStatus('failure', "Build #${env.BUILD_NUMBER} has failing tests") } }
        failure { script { githubStatus('failure', "Build #${env.BUILD_NUMBER} failed") } }
        aborted { script { githubStatus('error', "Build #${env.BUILD_NUMBER} was stopped") } }
        cleanup {
            script {
                if (!keepsWorkspace()) {
                    // A pull request or tag build: its reports and release files are archived by now (post always and
                    // the archive stages run first), so the whole throwaway workspace goes, passed or failed.
                    deleteDir()
                } else if (workspaceStarted) {
                    // Keep node_modules for the next build; everything else git does not track goes.
                    sh 'git clean -ffdx -e node_modules'
                } else {
                    echo 'No workspace was started; skipping cleanup.'
                }
            }
        }
    }
}
