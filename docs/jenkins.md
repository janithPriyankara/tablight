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

The pipeline cleans its workspace, checks out code, installs lockfile dependencies, runs ESLint, TypeScript and unit tests, prepares the checksum-verified model assets (the bundled model is committed in the repository and only verified; `scripts/model-cache.mjs` removes any other model left in `public/models` and does not use the `/tmp/tablight-model-cache` cache for a committed model), and packages the extension. Optional model-quality tests run after asset preparation; optional browser tests run against the built extension. Command failures stop the build and prevent release archiving.

Successful builds expose `release/tablight-<version>.zip` under **Artifacts**. JUnit reports and Playwright failure traces are archived before workspace cleanup. The timeout is 60 minutes; Jenkins retains 20 build records and artifacts from the latest 5 builds. Browser store publishing remains manual.

Allow outbound access to image registries, npm and Debian mirrors during image construction, plus GitHub, npm and optional Playwright browser downloads during builds (Hugging Face is no longer needed: the bundled model is committed). Start with 2 CPUs and 4 GB RAM; allow more for quality/browser suites. Keep the Dockerfile's Playwright dependency-install version aligned with `@playwright/test` when upgrading it.

## Security gates

Every build (main, pull requests, tags, releases) runs these stages one after another, so the shared host never carries more than one at a time. Any finding fails the build, so a release cannot go out with one.

| Stage | What it checks | Cost |
|---|---|---|
| Supply chain | OSV-Scanner over `package-lock.json` and `scripts/finetune/requirements.txt`; `npm audit` at any severity; `npm audit signatures` | One static binary (cached in `/tmp/tablight-tools`), a few registry requests |
| Secret scan | gitleaks over the whole git history (redacted report) | One static binary (cached) |
| Lint | ESLint, including `eslint-plugin-security` on `src/` and the DOM-injection bans | Incremental cache in `/tmp` |
| Type check | `tsc --noEmit` | Incremental cache in `/tmp` |
| Unit tests | The unit suite with v8 coverage thresholds (`vitest.config.ts`), including the security suites `redos`, `security-model` and `security-rpc` | Coverage adds little |
| Sonar | Self-hosted SonarQube Community with coverage, on main and release builds only (Community analyzes main alone); the build waits for the quality gate | Scanner JVM capped at 512 MB; the server runs separately |
| Build and package | `verify-release` (permissions, CSP, URL allowlist, licenses, hashes, size), the ZIP, and a CycloneDX SBOM | — |

Binaries are pinned by version and checked against their release's published checksums before first use.

Pull request and tag builds run in a throwaway workspace: emptied before checkout, deleted at the end (passed or failed) after reports and release files are archived. When their lockfile matches main's, `node_modules` is hard-linked from main's workspace (`/var/jenkins_home/jobs/tablight-cicd/branches/main/workspace`) instead of installed; main keeps its workspace as that shared source.

### Sonar setup (once)

SonarQube Community runs on the Jenkins host in the container `sonarqube`, on Jenkins' Docker network `web` (restart: unless-stopped), so the pipeline reaches it at `http://sonarqube:9000`; the UI is public at https://sonar.theteapotlk.com. Memory is tight (4 GB host, SonarQube capped at 1.8 GB), so the scanner runs alone, after the unit tests, with a 512 MB JVM.

1. In SonarQube, create the project with the key `tablight` and main branch `main` (or let the first analysis create it).
2. Create a project analysis token and add it in Jenkins as a **Secret text** credential with the id `sonar-token`.

Pull request and tag builds skip the stage (Community has no branch or pull request analysis). Until the credential exists, main builds skip it with a notice; a release build fails instead.

## Troubleshooting

- **node/npm not found:** check that the NodeJS plugin is enabled, the tool is named exactly `nodejs22.23.5`, and its automatic download succeeds.
- **Still seeing docker inspect/pull:** confirm Jenkins fetches the latest main, rather than replaying an old pipeline.
- **Waiting for an executor:** make sure the node is online, has an executor, and allows this job to run there.
- **Workspace permission denied:** earlier root-based builds may have left files owned by root. Repair ownership only in this job's workspace to match the Jenkins user.
- **Browser libraries missing:** leave browser tests off or have an administrator prepare the browser libraries on a suitable agent.
- **Tests fail:** inspect reports and logs; these remain required build failures.

Local npm checks do not establish a Jenkins runtime result. Validate the Declarative syntax with your Jenkins [Pipeline linter](https://www.jenkins.io/doc/book/pipeline/development/#linter), then run the job on the VM.
