// Commands run directly inside the existing Jenkins node/container.
def workspaceStarted = false
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
            steps {
                // npm ci only when the lockfile or Node changed since node_modules was installed. The stamp is
                // written after a successful install, so a broken or partial install is never reused.
                sh '''
                    want="$(sha256sum package-lock.json | cut -c1-64) $(node --version)"
                    if [ -d node_modules ] && [ "$(cat node_modules/.tablight-lock 2>/dev/null)" = "$want" ]; then
                        echo "node_modules is current for this lockfile; skipping npm ci"
                    else
                        rm -f node_modules/.tablight-lock
                        npm ci --no-audit --no-fund
                        echo "$want" > node_modules/.tablight-lock
                    fi
                '''
            }
        }
        stage('Checks and unit tests') {
            // Independent of each other, so they run side by side.
            parallel {
                // Both re-check only what changed since the last build (results kept in /tmp, keyed by file content).
                stage('Lint') {
                    steps { sh 'npm run lint -- --cache --cache-strategy content --cache-location /tmp/tablight-eslint-cache/' }
                }
                stage('Type check') {
                    steps { sh 'npx --no-install tsc --noEmit --incremental --tsBuildInfoFile /tmp/tablight-tsc/tsbuildinfo' }
                }
                stage('Unit tests') {
                    steps {
                        sh 'npm test -- --reporter=default --reporter=junit --outputFile.junit=reports/unit.xml'
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
                archiveArtifacts artifacts: 'release/tablight-*.zip', fingerprint: true
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
                        tag="v$(node -p "require('./package.json').version")"
                        url="https://x-access-token:$GH_TOKEN@github.com/janithPriyankara/tablight.git"
                        # Fails (and releases nothing) if main moved on GitHub while this build ran.
                        git push "$url" main "$tag"
                        echo "$tag" > release-tag.txt
                    '''
                }
                archiveArtifacts artifacts: 'release/tablight-*.zip', fingerprint: true
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
                        code=$(curl -s -o asset.json -w '%{http_code}' -X POST -H "$auth" \\
                            -H "Content-Type: application/zip" --data-binary "@$zip" \\
                            "https://uploads.github.com/repos/janithPriyankara/tablight/releases/$id/assets?name=tablight-$version.zip" \\
                            || echo curl-failed)
                        if [ "$code" != 201 ]; then
                            echo "Uploading $zip failed: HTTP $code" >&2
                            sed -n 1,20p asset.json >&2
                            exit 1
                        fi
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
                if (workspaceStarted) {
                    // Keep node_modules for the next build; everything else git does not track goes.
                    sh 'git clean -ffdx -e node_modules'
                } else {
                    echo 'No workspace was started; skipping cleanup.'
                }
            }
        }
    }
}
