# Jenkins on a Linux VM

The root `Jenkinsfile` builds Tablight in `node:22-bookworm`. It checks out a fresh workspace, installs the lockfile dependencies, runs ESLint, TypeScript and unit tests, downloads the checksum-verified model, and runs `npm run package`. The package command builds the extension and checks the release before creating `release/tablight-<version>.zip`.

## Prepare your existing Docker-hosted Jenkins

Install these Jenkins plugins through **Manage Jenkins → Plugins**:

- Pipeline (including Declarative Pipeline)
- Git
- Docker Pipeline (the `docker-workflow` plugin)
- JUnit

Give a Linux Jenkins node the label **docker** under **Manage Jenkins → Nodes → your node → Configure**. That node needs Git, a Docker CLI, and access to a running Docker daemon. Node.js is provided by the build container, so it does not need to be installed in the Jenkins container.

For Docker-hosted Jenkins, the controller container and the build agent are separate concerns. Prefer a dedicated Docker-capable agent; label that agent `docker`. If you intentionally run builds on your existing Jenkins container, it needs a nonzero executor count, the same label, and a Docker CLI installed in its image. The stock Jenkins image alone is insufficient.

When using the VM's Docker daemon, mount `/var/run/docker.sock:/var/run/docker.sock` into the **agent** container and give its user the socket's numeric group ID (`stat -c '%g' /var/run/docker.sock` on the VM). In a Compose service, these additions look like this:

```yaml
# Merge into your existing Jenkins agent service; retain its image, volumes and other settings.
group_add:
  - "${DOCKER_GID}"
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

Set `DOCKER_GID` in your Compose `.env` to the numeric ID from `stat`, then recreate the agent container. Docker socket access grants control of the VM's Docker daemon: use this agent for trusted repositories only. Do not expose an unauthenticated Docker TCP port.

The daemon must be able to see the agent workspace. For a containerized agent on the same daemon, Docker Pipeline normally detects the agent container and shares its volumes automatically. Preserve its Jenkins workspace/home volume. If detection fails, mount the workspace at the **same absolute path** on the host and agent; a remote daemon with an unrelated filesystem will not work with this setup. See [Jenkins Docker Pipeline documentation](https://www.jenkins.io/doc/book/pipeline/docker/).

Before creating the job, run `docker version` and `docker run --rm node:22-bookworm node --version` as the Jenkins agent user inside its container. Both must succeed. These commands only prove Docker access; workspace sharing is verified by the pipeline checkout stage.

Allow outbound HTTPS for GitHub, the npm registry, Docker Hub and Hugging Face's model download/CDN endpoints. Optional browser tests also need Playwright's browser downloads and Debian package mirrors. Start with at least 2 CPUs and 4 GB RAM for normal builds; allow more for model and browser tests.

## Create the build job

1. Create a **Pipeline** job named `tablight`.
2. Select **Pipeline script from SCM**, then **Git**.
3. Repository URL: `https://github.com/janithPriyankara/tablight.git`.
4. Add a GitHub credential if the repository is private.
5. Branch specifier: `*/main`. Script path: `Jenkinsfile`.
6. Save and select **Build Now**. The Jenkinsfile must be committed and pushed to the selected branch first.

After the first run registers the parameters, **Build with Parameters** offers:

- `RUN_QUALITY_TESTS`: model/classification checks, off by default.
- `RUN_E2E_TESTS`: installs Chromium and Linux libraries and runs the extension tests in headless Chromium, off by default.

The build container runs as root so Playwright can install its Linux dependencies. It is removed by Docker Pipeline after the build. A shell command inside the build container removes workspace entries, including root-owned build files, after reports are archived; Jenkins' agent-side `deleteDir()` alone cannot reliably remove those files. No privileged container or Docker socket mount inside the Node build container is required.

Successful builds expose the extension ZIP under **Artifacts**. Test results appear on the build page, including failures. Reports and Playwright failure traces are archived for diagnostics. Failed checks stop the build and prevent release archiving. Builds time out after 60 minutes; Jenkins keeps 20 build records and artifacts from the latest 5 builds. Publishing to browser stores remains manual.

## Troubleshooting

- **Waiting for an executor:** bring the `docker`-labelled agent online and give it an executor.
- **Invalid agent type docker:** install Docker Pipeline and restart Jenkins if requested.
- **docker: not found / permission denied / cannot connect:** fix the Docker CLI, socket group or daemon configuration on the agent container.
- **Workspace missing or durable task never starts:** check workspace sharing between the agent and sibling build container.
- **Tests or lint fail:** inspect the stage output and reports; these checks are intentionally required. Do not bypass them to produce a release ZIP.
- **Model download fails:** check outbound network access; downloads must pass the project's pinned checksums.

The pipeline cannot be validated end to end without a running Jenkins instance and Docker daemon. You can validate its Declarative syntax on your Jenkins using the [Pipeline linter](https://www.jenkins.io/doc/book/pipeline/development/#linter), then run a normal build and a build with both optional suites enabled.
