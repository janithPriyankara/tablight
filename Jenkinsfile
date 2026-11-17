// Commands run directly inside the existing Jenkins node/container.
def workspaceStarted = false

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
    parameters {
        booleanParam(name: 'RUN_QUALITY_TESTS', defaultValue: false,
            description: 'Run model/classification quality tests (requires extra CPU and memory).')
        booleanParam(name: 'RUN_E2E_TESTS', defaultValue: false,
            description: 'Download Chromium and test the extension; requires Chromium Linux libraries on this node.')
        string(name: 'E2E_WORKERS', defaultValue: '3',
            description: 'How many browser test files run at once (each starts its own Chromium).')
    }
    environment {
        CI = 'true'
        npm_config_cache = '/tmp/tablight-npm-cache'
        PLAYWRIGHT_BROWSERS_PATH = '/tmp/tablight-browsers'
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
        stage('Static checks') {
            steps {
                sh 'npm run lint'
                sh 'npx --no-install tsc --noEmit'
            }
        }
        stage('Unit tests') {
            steps {
                sh 'npm test -- --reporter=default --reporter=junit --outputFile.junit=reports/unit.xml'
            }
        }
        stage('Prepare model assets') {
            steps { sh 'npm run prepare:assets' }
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
            when { expression { params.RUN_E2E_TESTS } }
            steps {
                sh 'npx --no-install playwright install chromium'
                // No root on this shared host: Chromium's system libraries go into a private folder.
                sh "scripts/ci/e2e-no-root.sh --reporter=list,junit --workers=${params.E2E_WORKERS}"
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
