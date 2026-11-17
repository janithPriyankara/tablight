pipeline {
    agent {
        docker {
            image 'node:22-bookworm'
            label 'docker'
            // Root is needed only for Playwright's optional Linux library installation.
            args '--user 0:0 --init --shm-size=1g'
        }
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
            description: 'Install Chromium and Linux libraries, then test the built extension.')
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
                sh 'npx --no-install playwright install --with-deps chromium'
                sh 'npm run test:e2e -- --reporter=list,junit'
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
            junit testResults: 'reports/*.xml', allowEmptyResults: true
            archiveArtifacts artifacts: 'reports/**,test-results/**', allowEmptyArchive: true
        }
        cleanup {
            // sh runs as container root; deleteDir uses the agent user and cannot remove root-owned dirs.
            // Limit removal to entries in the allocated Jenkins workspace, including hidden files.
            sh 'find . -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
        }
    }
}
