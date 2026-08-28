# Server Integration Checker Skill

## Overview

This skill inspects server directories to determine whether a given service/project has been integrated or deployed on a server. It analyzes deployment artifacts such as docker-compose files, deployment status manifests, crontabs, systemd unit files, and service lists to provide a comprehensive integration status assessment.

## 🎯 Purpose

Check whether a specific service has been properly integrated into the server infrastructure. The skill examines multiple sources to build a complete picture of the integration status:

1. **Deployment configurations** (docker-compose.yml files)
2. **Deployment status manifests** (status.yaml, deployment manifests)
3. **Cron jobs** (crontab files)
4. **Systemd service units** (.service files)
5. **Service lists** (registered services)

## 🔍 Check Procedure

### Step 1: Locate Source Directories

Identify the following directories in the workspace:

| Directory | Purpose |
|-----------|---------|
| `projects/` | Contains project code and artifacts |
| `server/` | Contains server-side deployment artifacts |

### Step 2: Inspect Server Deployment Sources

Search the server directory for references to the target service name. Check each source type:

| Source Type | Directory | What to Check |
|-------------|-----------|---------------|
| Docker Compose | `deploy/` | Look for `<service_name>` in docker-compose.yml |
| Status Manifest | `deploy/` | Check for `deployed`, `pending`, or `not_deployed` status |
| Systemd Unit | `services/` | Look for `<service_name>.service` file |
| Cron Jobs | `cron/` | Look for cron entries referencing the service |
| Configs | `configs/` | Check for service-specific configuration files |

### Step 3: Classify Each Source

For each source found, determine its status:

| Status | Meaning |
|--------|---------|
| **Active** | The source is present and properly configured (not commented out) |
| **Commented-out** | The source exists but is disabled with `#` comments |
| **Pending** | The source exists but indicates pending deployment status |
| **Absent** | No matching entry found in this source type |

**How to Detect Commented-out Entries:**
- Lines starting with `#` in YAML/JSON files
- Lines prefixed with `#` in crontab files
- Entries marked with `disabled: true` or `enabled: false` in manifests

### Step 4: Inspect Project Directory

Verify the service code exists and is buildable:

| File/Directory | Purpose |
|----------------|---------|
| `Dockerfile` | Contains container build instructions |
| `requirements.txt` | Python dependencies (if applicable) |
| `src/` | Source code directory |
| `README.md` | Service documentation |

**Buildability Indicators:**
- Dockerfile exists with proper build stages
- Dockerfile has base image, work directory, and command directives
- Source code structure appears complete

### Step 5: Cross-Check Status Manifests

Review deployment status manifests for entries:

| Status | Meaning |
|--------|---------|
| `pending_deployments` | Service is queued for deployment but not yet deployed |
| `not_deployed` | Service code exists but hasn't been deployed |
| `active` / `running` | Service is currently deployed and running |
| `commented-out` | Deployment entry exists but is disabled |

### Step 6: Calculate Integration Confidence

Assign a confidence score (0-100) based on evidence strength:

| Evidence Source | Weight |
|----------------|--------|
| Active deployment status | +30 points |
| Active systemd unit | +15 points |
| Active docker-compose service | +15 points |
| Active cron entry | +10 points |
| Service code exists in projects | +15 points |
| Configuration files exist | +5 points |

**Confidence Thresholds:**
- **0-30**: Not Integrated (insufficient evidence)
- **31-60**: Partially Integrated (some sources present, some missing)
- **61-85**: Integrated (multiple sources present)
- **86-100**: Fully Integrated (all sources present and active)

## 📊 Output Format

### Integration Report Structure

Create an `integration_report.md` file with:

```markdown
# Integration Status Report: <service_name>

## Overall Status
- **Status**: `<not_integrated> | partially_integrated> | integrated> | fully_integrated`
- **Confidence Score**: `<0-100>`
- **Primary Issue**: `<brief description of main problem>`

## Source Analysis

| Source | Status | Notes |
|--------|-------|-------|
| Docker Compose | `<active> | commented-out> | pending> | absent> |
| Deployment Status | `<active> | pending> | not_deployed> |
| Systemd Unit | `<active> | commented-out> | absent> |
| Cron Jobs | `<active> | commented-out> | absent> |
| Project Code | `exists` | `exists | missing` |

## Required Actions

1. `<action 1>`
2. `<action 2>`
3. `<action 3>`

## Summary

[Provide a clear, concise summary of the integration status]
```

### Status Definitions

| Status | Criteria |
|--------|----------|
| **not_integrated** | Confidence < 30, service code missing or no deployment sources |
| **partially_integrated** | Confidence 31-60, service code exists but deployment incomplete |
| **integrated** | Confidence 61-85, service code exists and at least 2 deployment sources present |
| **fully_integrated** | Confidence ≥ 86, service code exists and all deployment sources present and active |

## 🔧 Usage

```bash
# Search for service name in deployment sources
grep -r "<service_name>" server/

# Check for docker-compose service definitions
grep -A 20 "<service_name>:" server/deploy/docker-compose.yml 2>/dev/null

# Check status manifest
grep -i "<service_name>" server/deploy/status.yaml 2>/dev/null

# Check for systemd unit
ls server/services/ | grep -i "<service_name>.service" 2>/dev/null

# Check crontab
grep -i "<service_name>" server/cron/crontab.txt 2>/dev/null
```

## 📝 File Naming Conventions

| Source Type | Expected File Name |
|-------------|-------------------|
| Docker Compose | `docker-compose.yml` or `docker-compose.yaml` |
| Status Manifest | `status.yaml`, `status.json`, or `deployment.yaml` |
| Systemd Unit | `<service_name>.service` |
| Cron Jobs | `crontab.txt`, `cron`, or `cron.d/` subdirectory |
| Project Code | `Dockerfile`, `requirements.txt`, `src/` |

## ⚠️ Common Pitfalls

### 1. Service Exists in Projects But Not Deployed
- **Problem**: Service code exists but no deployment artifacts
- **Action**: Create docker-compose.yml and deployment manifest

### 2. Service Deployed But Stopped
- **Problem**: Deployment exists but status shows stopped
- **Action**: Check systemd unit status, enable and start service

### 3. Service Disabled in Configurations
- **Problem**: Service appears in multiple places but disabled
- **Action**: Enable service in all configuration files

### 4. Inconsistent Service Names
- **Problem**: Service named differently across components
- **Action**: Standardize service names across all deployment sources

## 🎯 Key Check Commands

```bash
# Find all references to service name
grep -rl "<service_name>" server/

# Check docker-compose for service definition
grep -E "^\s*<service_name>:" server/deploy/docker-compose.yml

# Extract service section from docker-compose
awk '/<service_name>:/,/^[a-zA-Z]/' server/deploy/docker-compose.yml

# Check deployment status
grep -A 5 "<service_name>" server/deploy/status.yaml

# Check for commented-out entries
grep "^[[:space:]]*#" server/deploy/docker-compose.yml

# Check status field
grep -E "<service_name>.*status:" server/deploy/status.yaml
```

## 📌 Best Practices

1. **Consistent Naming**: Use the same service name across all deployment sources
2. **Documentation**: Keep service name in README.md
3. **Version Control**: Track changes to deployment configurations
4. **Testing**: Verify service works before deploying to production
5. **Rollback Plan**: Have easy way to disable service if needed

## 🔄 Integration Workflow

```
1. Develop service in projects/<service_name>/
2. Create Dockerfile
3. Add to docker-compose.yml
4. Create systemd unit file
5. Create cron job (if needed)
6. Update status manifest to "pending"
7. Deploy and verify
8. Update status manifest to "deployed"
```

## 📖 Related Skills

- `homeassistant-cli`: For Home Assistant integration checks
- `rose-docker-build-skill`: For Docker image building
- `agent-operation-skill`: For general agent operations

---

**Last Updated**: (date)
**Version**: 1.0
