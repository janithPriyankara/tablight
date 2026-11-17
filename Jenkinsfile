// Commands run directly inside the existing Jenkins node/container.
def workspaceStarted = false
// True when the cron trigger started this build.
def isNightly() {
    return !currentBuild.getBuildCauses('hudson.triggers.TimerTrigger$TimerTriggerCause').isEmpty()
}
// A release: a build of a pushed tag like v1.2.3 (multibranch job with tag discovery).
def isRelease() {
    return env.TAG_NAME ==~ /v\d+\.\d+\.\d+/
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
                // The model (~33 MB) is kept between builds; fetch-model re-downloads only files whose
                // SHA-256 does not match the pinned manifest.
                sh 'mkdir -p "$MODEL_CACHE" public/models && cp -R "$MODEL_CACHE"/. public/models/'
                sh 'npm run prepare:assets'
                sh 'cp -R public/models/. "$MODEL_CACHE"/'
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
        stage('GitHub release') {
            // Only for a v1.2.3 tag, and only when every stage above passed (a failed stage stops the build).
            when { expression { isRelease() && currentBuild.currentResult == 'SUCCESS' } }
            steps {
                withCredentials([usernamePassword(credentialsId: 'dcc58858-b705-437a-adac-d64dd39c12a3',
                        usernameVariable: 'GH_USER', passwordVariable: 'GH_TOKEN')]) {
                    sh '''
                        set -eu
                        version=$(node -p "require('./package.json').version")
                        if [ "v$version" != "$TAG_NAME" ]; then
                            echo "Tag $TAG_NAME does not match package.json version $version; not releasing." >&2
                            exit 1
                        fi
                        zip="release/tablight-$version.zip"
                        api=https://api.github.com/repos/janithPriyankara/tablight
                        auth="Authorization: Bearer $GH_TOKEN"
                        code=$(curl -s -o release.json -w '%{http_code}' -X POST -H "$auth"                             -H "Accept: application/vnd.github+json" "$api/releases"                             -d "{\"tag_name\":\"$TAG_NAME\",\"name\":\"Tablight $version\",\"generate_release_notes\":true}")
                        if [ "$code" != 201 ]; then
                            echo "Creating the GitHub release failed: HTTP $code" >&2
                            sed -n 1,20p release.json >&2
                            exit 1
                        fi
                        id=$(node -p "require('./release.json').id")
                        page=$(node -p "require('./release.json').html_url")
                        code=$(curl -s -o asset.json -w '%{http_code}' -X POST -H "$auth"                             -H "Content-Type: application/zip" --data-binary "@$zip"                             "https://uploads.github.com/repos/janithPriyankara/tablight/releases/$id/assets?name=tablight-$version.zip")
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
