---
name: server-integration-checker
description: Checks whether a given project or service has been integrated/deployed on a server by inspecting deployment artifacts, cron jobs, systemd units, docker-compose files, and service lists.
---

# Server Integration Checker

## Overview
This skill checks whether a named service has been integrated into a server infrastructure. It analyzes multiple deployment sources to determine the integration status.

## Parameters
- `service_name`: (string) The name of the service to check for integration.
- `server_name`: (string, optional) The name of the server to check. Defaults to checking all servers.
- `check_types`: (list of strings, optional) The types of checks to perform:
  - `deployments`: Check deployment manifests (Kubernetes, Helm, etc.)
  - `docker`: Check Docker deployment configurations
  - `systemd`: Check systemd unit files
  - `cron`: Check cron job entries
  - `services`: Check service/process lists
  - `all`: Perform all checks (default)

## Returns
A structured response containing:
- `integrated`: Boolean indicating if the service is integrated
- `integration_sources`: List of where the service was found
- `integration_confidence`: Float (0-1) indicating confidence in the result
- `details`: Additional information about the integration

## Usage Examples
```python
# Check if a service is integrated
check_service(service_name="daily_stock_analysis", check_types=["deployments", "docker"])

# Check all servers for a service
check_service(service_name="daily_stock_analysis", check_types=["all"])

# Check for multiple sources
check_service(service_name="daily_stock_analysis", check_types=["cron", "systemd", "services"])
```

## Implementation Notes
This skill will inspect:
1. Deployment configuration files
2. Docker-related configurations (docker-compose.yml, Dockerfiles)
3. Systemd service unit files
4. Cron job schedules
5. Running service processes

The skill will cross-reference the specified service name against these sources and determine if the service exists in the target server configuration.

## Limitations
- Requires appropriate file system permissions to read configuration files
- May not detect services deployed via ad-hoc methods or third-party platforms
- Cannot verify if a service is actually running, only if it's configured
