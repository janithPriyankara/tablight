# Jenkins build design

Updated per user request: build and test directly inside the existing Docker-hosted Jenkins container. Use `agent any`, Node.js 22 and npm installed in the Jenkins image, required lint/type/unit checks, pinned model preparation and existing release packaging. Archive JUnit reports and the extension ZIP; browser and quality suites remain optional. No Docker CLI/socket or Docker Pipeline plugin is required by the job.

The Jenkins Dockerfile extends the existing Debian-based Jenkins image, installs browser OS libraries at image-build time as root, and returns to the Jenkins user. Preserve the Jenkins home volume when recreating the container. Multiple-node installations must target a node with the prepared runtime. No browser-store deployment.

Approaches: a sibling Docker build container required extra daemon/CLI setup. The user selected direct builds in the Jenkins container instead, simplifying this single-node VM setup. Java and Node therefore coexist in the Jenkins image.

Shared Jenkins correction: preserve its existing Go/Java/Android toolchains and image. Select the Jenkins NodeJS plugin installation `node22` through the Declarative tools directive. Browser OS libraries remain a separate optional prerequisite.
