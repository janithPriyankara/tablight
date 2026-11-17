# Jenkins build design

Approved in conversation: Linux VM with Docker-hosted Jenkins; use a Node.js 22 build container, required static/unit checks, pinned model preparation and the existing release packaging command. Archive JUnit reports and the extension ZIP. Browser and quality suites are optional parameters. Include VM setup instructions; no store deployment.

Approaches: host-installed Node requires maintaining a second runtime in Jenkins; a Docker Pipeline agent supplies the runtime consistently and fits the user's Docker installation, so it is selected. A dedicated Docker-capable agent is preferred; an existing controller can serve a personal lab if explicitly configured for builds.
