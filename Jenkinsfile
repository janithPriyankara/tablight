// Commands run directly inside the existing Jenkins node/container.
def workspaceStarted = false
// True when the cron trigger started this build.
def isNightly() {
    return !currentBuild.getBuildCauses('hudson.triggers.TimerTrigger$TimerTriggerCause').isEmpty()
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
        // Nightly: full browser suite and the spec's 500-tab performance check (see Browser tests).
        cron('H 2 * * *')
    }
    parameters {
        booleanParam(name: 'RUN_QUALITY_TESTS', defaultValue: false,
            description: 'Run model/classification quality tests (requires extra CPU and memory).')
        booleanParam(name: 'RUN_E2E_TESTS', defaultValue: false,
            description: 'Download Chromium and test the extension; requires Chromium Linux libraries on this node.')
        string(name: 'PERF_TABS', defaultValue: '100',
            description: 'Tabs opened by the @perf test. The nightly build always uses 500.')
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
                script { workspaceStarted = true }
                // Prevent old ZIPs, reports or downloaded assets from masking a failure.
                deleteDir()
                checkout scm
                sh 'node --version && npm --version && mkdir -p reports'
            }
        }
        stage('Install dependencies') {
            steps { sh 'npm ci --no-audit --no-fund' }
        }
        stage('Checks and unit tests') {
            // Independent of each other, so they run side by side.
            parallel {
                stage('Lint') { steps { sh 'npm run lint' } }
                stage('Type check') { steps { sh 'npx --no-install tsc --noEmit' } }
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
            when { expression { params.RUN_QUALITY_TESTS } }
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
            when { expression { params.RUN_E2E_TESTS || isNightly() } }
            environment {
                PERF_TABS = "${isNightly() ? '500' : params.PERF_TABS}"
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
        cleanup {
            script {
                if (workspaceStarted) {
                    deleteDir()
                } else {
                    echo 'No workspace was started; skipping cleanup.'
                }
            }
        }
    }
}
