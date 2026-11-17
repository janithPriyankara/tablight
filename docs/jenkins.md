# Build directly inside Docker-hosted Jenkins

The root `Jenkinsfile` runs npm commands directly on the Jenkins node (`agent any`). In your single-node setup, that is the existing Jenkins container. It needs no Docker Pipeline plugin, Docker CLI or Docker socket inside Jenkins.

## Prepare the Jenkins image

`ci/jenkins/Dockerfile` adds Node.js 22, npm and Chromium's Linux libraries to a Debian-based Jenkins image. Image construction uses root; Jenkins and pipeline commands run as the normal `jenkins` user. The pipeline downloads Chromium as that user only when browser tests are enabled.

On your Linux VM, from a checkout of this repository:

```sh
git pull origin main
# Replace the base image below with your CURRENT Debian-based Jenkins image/tag.
docker build --build-arg JENKINS_IMAGE=jenkins/jenkins:lts-jdk21 \
  -f ci/jenkins/Dockerfile -t tablight-jenkins:local .
```

In your existing Jenkins Compose service, change `image:` to `tablight-jenkins:local`. If the service has a `build:` section, update it to use this Dockerfile instead. Keep the existing Jenkins home volume, ports, environment, networks and other settings. Recreate only that service:

```sh
# Replace jenkins with your actual Compose service name.
docker compose up -d --no-deps jenkins
docker compose exec --user jenkins jenkins node --version
docker compose exec --user jenkins jenkins npm --version
```

Do not delete your Jenkins home volume: it holds jobs, plugins and settings. No Docker socket mount, privileged mode or Docker group membership is needed for this pipeline. Remove any socket mount added solely for this job. Keep at least one executor online on the built-in node. Existing labels may remain; the pipeline no longer requires the `docker` label. With multiple nodes, constrain the pipeline agent to a label on nodes using the prepared image instead of `any`.

Recreating the container from the new image is necessary to acquire Node.js; pushing a Jenkinsfile alone cannot add Node to the running Jenkins container. If you launched Jenkins with `docker run`, recreate it using the new image and your original volume/port/settings arguments instead of Compose.

## Configure the job

Required Jenkins plugins: **Pipeline** (including Declarative), **Git**, and **JUnit**. Select **Pipeline script from SCM → Git**:

- Repository: `https://github.com/janithPriyankara/tablight.git`
- Branch: `*/main`
- Script path: `Jenkinsfile`
- Credentials: your GitHub credential if the repository is private

Save and run **Build Now**. After the first run registers parameters, **Build with Parameters** offers `RUN_QUALITY_TESTS` and `RUN_E2E_TESTS`, both off by default.

The pipeline cleans its workspace, checks out code, installs lockfile dependencies, runs ESLint, TypeScript and unit tests, prepares the checksum-verified model assets, and packages the extension. Optional model-quality tests run after asset preparation; optional browser tests run against the built extension. Command failures stop the build and prevent release archiving.

Successful builds expose `release/tablight-<version>.zip` under **Artifacts**. JUnit reports and Playwright failure traces are archived before workspace cleanup. The timeout is 60 minutes; Jenkins retains 20 build records and artifacts from the latest 5 builds. Browser store publishing remains manual.

Allow outbound access to image registries, npm and Debian mirrors during image construction, plus GitHub, npm, Hugging Face model/CDN endpoints and optional Playwright browser downloads during builds. Start with 2 CPUs and 4 GB RAM; allow more for quality/browser suites. Keep the Dockerfile's Playwright dependency-install version aligned with `@playwright/test` when upgrading it.

## Troubleshooting

- **node/npm not found:** recreate Jenkins using the prepared image and verify versions as the Jenkins user.
- **Still seeing docker inspect/pull:** confirm Jenkins fetches the latest main, rather than replaying an old pipeline.
- **Waiting for an executor:** make sure the node is online, has an executor, and allows this job to run there.
- **Workspace permission denied:** earlier root-based builds may have left files owned by root. Repair ownership only in this job's workspace to match the Jenkins user.
- **Browser libraries missing:** rebuild the image with its Playwright dependency-install step; pipeline steps intentionally do not require root.
- **Tests fail:** inspect reports and logs; these remain required build failures.

Local npm checks do not establish a Jenkins runtime result. Validate the Declarative syntax with your Jenkins [Pipeline linter](https://www.jenkins.io/doc/book/pipeline/development/#linter), then run the job on the VM.
