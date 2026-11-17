# Build directly inside Docker-hosted Jenkins

The root `Jenkinsfile` runs npm commands directly on the Jenkins node (`agent any`). In your single-node setup, that is the existing Jenkins container. It needs no Docker Pipeline plugin, Docker CLI or Docker socket inside Jenkins.

## Configure Node.js without changing the shared Jenkins image

Install the **NodeJS** Jenkins plugin. Under **Manage Jenkins → Tools → NodeJS installations**, add an installation named exactly `nodejs22.23.5`, enable automatic installation, and choose a Node.js 22.x release. Save it. The Jenkinsfile selects `tools { nodejs 'nodejs22.23.5' }`, which installs the tool on demand and adds it to this pipeline's PATH. Other jobs keep their existing tool configuration. No container rebuild or Docker socket is required. Allow access to nodejs.org for automatic downloads.

Keep at least one executor online on the intended node. Existing labels can remain; this job does not require the `docker` label. If Jenkins has multiple nodes, restrict this job's agent to a suitable Linux node instead of `any`.

Leave `RUN_E2E_TESTS` off unless Chromium's Linux libraries are already installed on the node. NodeJS tool installation does not install OS libraries. The repository's `ci/jenkins/Dockerfile` remains an optional image for a dedicated Jenkins installation; it is not required for your shared Jenkins and should not replace its existing image.

## Configure the job

Required Jenkins plugins: **Pipeline** (including Declarative), **Git**, **NodeJS**, and **JUnit**. Select **Pipeline script from SCM → Git**:

- Repository: `https://github.com/janithPriyankara/tablight.git`
- Branch: `*/main`
- Script path: `Jenkinsfile`
- Credentials: your GitHub credential if the repository is private

Save and run **Build Now**. After the first run registers parameters, **Build with Parameters** offers `RUN_QUALITY_TESTS` and `RUN_E2E_TESTS`, both off by default.

The pipeline cleans its workspace, checks out code, installs lockfile dependencies, runs ESLint, TypeScript and unit tests, prepares the checksum-verified model assets, and packages the extension. Optional model-quality tests run after asset preparation; optional browser tests run against the built extension. Command failures stop the build and prevent release archiving.

Successful builds expose `release/tablight-<version>.zip` under **Artifacts**. JUnit reports and Playwright failure traces are archived before workspace cleanup. The timeout is 60 minutes; Jenkins retains 20 build records and artifacts from the latest 5 builds. Browser store publishing remains manual.

Allow outbound access to image registries, npm and Debian mirrors during image construction, plus GitHub, npm, Hugging Face model/CDN endpoints and optional Playwright browser downloads during builds. Start with 2 CPUs and 4 GB RAM; allow more for quality/browser suites. Keep the Dockerfile's Playwright dependency-install version aligned with `@playwright/test` when upgrading it.

## Troubleshooting

- **node/npm not found:** check that the NodeJS plugin is enabled, the tool is named exactly `nodejs22.23.5`, and its automatic download succeeds.
- **Still seeing docker inspect/pull:** confirm Jenkins fetches the latest main, rather than replaying an old pipeline.
- **Waiting for an executor:** make sure the node is online, has an executor, and allows this job to run there.
- **Workspace permission denied:** earlier root-based builds may have left files owned by root. Repair ownership only in this job's workspace to match the Jenkins user.
- **Browser libraries missing:** leave browser tests off or have an administrator prepare the browser libraries on a suitable agent.
- **Tests fail:** inspect reports and logs; these remain required build failures.

Local npm checks do not establish a Jenkins runtime result. Validate the Declarative syntax with your Jenkins [Pipeline linter](https://www.jenkins.io/doc/book/pipeline/development/#linter), then run the job on the VM.
