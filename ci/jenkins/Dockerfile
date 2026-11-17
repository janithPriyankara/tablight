# Override with your CURRENT Debian-based Jenkins image/tag to retain its version/customizations.
ARG JENKINS_IMAGE=jenkins/jenkins:lts-jdk21
FROM node:22-bookworm AS node_runtime
FROM ${JENKINS_IMAGE}

USER root
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node_runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version

# Match @playwright/test in package-lock.json. Install OS libraries at image-build time.
# The pipeline downloads Chromium as the non-root Jenkins user only when requested.
RUN npx --yes playwright@1.65.1 install-deps chromium
USER jenkins
