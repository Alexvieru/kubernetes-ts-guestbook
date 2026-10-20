// Copyright 2016-2025, Pulumi Corporation.  All rights reserved.

import * as fs from "fs";
import * as path from "path";

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";

// Minikube does not implement services of type `LoadBalancer`; require the user to specify if we're
// running on minikube, and if so, create only services of type ClusterIP (and a NodePort for Grafana).
const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube");
// Name of the cluster node whose IP is used to build the Grafana URL on minikube.
const minikubeNodeName = config.get("minikubeNodeName") || "minikube";

//
// NAMESPACE.
//

const appNamespace = new k8s.core.v1.Namespace("guestbook", {
    metadata: { name: `guestbook-${pulumi.getStack()}` },
});
const namespace = appNamespace.metadata.name;

// Prometheus exporters are run as sidecars: both Apache's `server-status` and Redis' `INFO` are
// per-instance, so each pod needs its own exporter scraped individually.
const metricsPortName = "metrics";

//
// REDIS LEADER.
//

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { namespace, labels: redisLeaderLabels },
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter",
                        env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
                        resources: { requests: { cpu: "10m", memory: "32Mi" } },
                        ports: [{ name: metricsPortName, containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});
const redisLeaderService = new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        namespace,
        labels: redisLeaderDeployment.metadata.labels,
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: metricsPortName, port: 9121, targetPort: 9121 },
        ],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

//
// REDIS REPLICA.
//

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    metadata: { namespace, labels: redisReplicaLabels },
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the leader's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter",
                        env: [{ name: "REDIS_ADDR", value: "redis://localhost:6379" }],
                        resources: { requests: { cpu: "10m", memory: "32Mi" } },
                        ports: [{ name: metricsPortName, containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});
const redisReplicaService = new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        namespace,
        labels: redisReplicaDeployment.metadata.labels,
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: metricsPortName, port: 9121, targetPort: 9121 },
        ],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

//
// FRONTEND
//

// Apache configuration and mtail program that turn the access log into Prometheus metrics.
const mtailPort = 3903;
const accessLogDir = "/var/log/guestbook";
const frontendMetricsConfig = new k8s.core.v1.ConfigMap("frontend-metrics", {
    metadata: { name: "frontend-metrics", namespace },
    data: {
        "apache-vhost.conf": fs.readFileSync(path.join(__dirname, "monitoring/apache-vhost.conf"), "utf8"),
        "guestbook.mtail": fs.readFileSync(path.join(__dirname, "monitoring/guestbook.mtail"), "utf8"),
    },
});

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace, labels: frontendLabels },
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        // If your cluster config does not include a dns service, then to instead access an environment
                        // variable to find the master service's host, change `value: "dns"` to read `value: "env"`.
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" /* value: "env"*/ }],
                        ports: [{ containerPort: 80 }],
                        volumeMounts: [
                            // Extra Apache access log in a compact format, shared with the mtail sidecar.
                            { name: "access-log", mountPath: accessLogDir },
                            {
                                name: "metrics-config",
                                mountPath: "/etc/apache2/sites-available/000-default.conf",
                                subPath: "apache-vhost.conf",
                                readOnly: true,
                            },
                        ],
                    },
                    {
                        // Request metrics (rate, status codes, latency) are derived from the Apache access log.
                        name: "mtail",
                        image: "ghcr.io/jaqx0r/mtail:3.4.17",
                        args: ["--progs", "/etc/mtail", "--logs", `${accessLogDir}/access.log`, "--logtostderr"],
                        resources: { requests: { cpu: "10m", memory: "32Mi" } },
                        ports: [{ name: metricsPortName, containerPort: mtailPort }],
                        volumeMounts: [
                            { name: "access-log", mountPath: accessLogDir, readOnly: true },
                            {
                                name: "metrics-config",
                                mountPath: "/etc/mtail/guestbook.mtail",
                                subPath: "guestbook.mtail",
                                readOnly: true,
                            },
                        ],
                    },
                ],
                volumes: [
                    { name: "access-log", emptyDir: {} },
                    { name: "metrics-config", configMap: { name: frontendMetricsConfig.metadata.name } },
                ],
            },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        labels: frontendDeployment.metadata.labels,
        name: "frontend",
        namespace,
    },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        ports: [
            { name: "http", port: 80 },
            { name: metricsPortName, port: mtailPort, targetPort: mtailPort },
        ],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

// Export the frontend IP.
export let frontendIp: pulumi.Output<string>;
if (isMinikube) {
    frontendIp = frontendService.spec.clusterIP;
} else {
    frontendIp = frontendService.status.loadBalancer.ingress[0].ip;
}

//
// MONITORING: kube-prometheus-stack (Prometheus operator, Prometheus, Grafana, kube-state-metrics).
//

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: "monitoring" },
});

// Stored encrypted in the Pulumi state only.
const grafanaAdminUser = "admin";
const grafanaAdminPassword = new random.RandomPassword("grafana-admin-password", {
    length: 16,
    special: false,
});

const grafanaServiceName = "grafana";
const disabled = { enabled: false };

const monitoring = new k8s.helm.v3.Release("kube-prometheus-stack", {
    chart: "kube-prometheus-stack",
    version: "92.11.0",
    namespace: monitoringNamespace.metadata.name,
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    values: {
        // Only what's needed: operator + Prometheus + Grafana + kube-state-metrics.
        alertmanager: disabled,
        nodeExporter: disabled,
        defaultRules: { create: false },
        kubeApiServer: disabled,
        kubeControllerManager: disabled,
        kubeScheduler: disabled,
        kubeEtcd: disabled,
        kubeProxy: disabled,
        coreDns: disabled,
        kubeStateMetrics: { enabled: true },
        // Kubelet ServiceMonitor provides cAdvisor container CPU / memory usage.
        kubelet: { enabled: true },
        prometheus: {
            prometheusSpec: {
                // Pick up ServiceMonitors from any namespace without requiring a `release` label.
                serviceMonitorSelectorNilUsesHelmValues: false,
                retention: "1d",
            },
        },
        grafana: {
            enabled: true,
            fullnameOverride: grafanaServiceName,
            adminUser: grafanaAdminUser,
            adminPassword: grafanaAdminPassword.result,
            service: { type: isMinikube ? "NodePort" : "LoadBalancer" },
            defaultDashboardsEnabled: false,
        },
    },
});

//
// SERVICE MONITORS: tell Prometheus to scrape the exporter port of each guestbook Service.
//

const serviceMonitorApiVersion = "monitoring.coreos.com/v1";

const frontendServiceMonitor = new k8s.apiextensions.CustomResource(
    "frontend",
    {
        apiVersion: serviceMonitorApiVersion,
        kind: "ServiceMonitor",
        metadata: { name: "guestbook-frontend", namespace },
        spec: {
            selector: { matchLabels: frontendLabels },
            endpoints: [{ port: metricsPortName, interval: "15s" }],
        },
    },
    { dependsOn: [monitoring, frontendService] },
);

const redisServiceMonitor = new k8s.apiextensions.CustomResource(
    "redis",
    {
        apiVersion: serviceMonitorApiVersion,
        kind: "ServiceMonitor",
        metadata: { name: "guestbook-redis", namespace },
        spec: {
            selector: {
                matchExpressions: [
                    { key: "app", operator: "In", values: [redisLeaderLabels.app, redisReplicaLabels.app] },
                ],
            },
            endpoints: [{ port: metricsPortName, interval: "15s" }],
        },
    },
    { dependsOn: [monitoring, redisLeaderService, redisReplicaService] },
);

//
// GRAFANA ACCESS DETAILS.
//

const grafanaService = k8s.core.v1.Service.get(
    "grafana",
    // Derived from the release's status so the lookup is deferred until the chart is installed.
    pulumi.interpolate`${monitoring.status.namespace}/${grafanaServiceName}`,
    { dependsOn: [monitoring] },
);

export let grafanaUrl: pulumi.Output<string>;
if (isMinikube) {
    const node = k8s.core.v1.Node.get("minikube-node", minikubeNodeName);
    const nodeIp = node.status.addresses.apply(
        (addresses) => addresses.find((a) => a.type === "InternalIP")?.address ?? "<node-ip>",
    );
    const nodePort = grafanaService.spec.ports.apply((ports) => ports.find((p) => p.port === 80)?.nodePort);
    grafanaUrl = pulumi.interpolate`http://${nodeIp}:${nodePort}`;
} else {
    const ingress = grafanaService.status.loadBalancer.ingress[0];
    grafanaUrl = pulumi.interpolate`http://${ingress.ip}`;
}
export const grafanaUser = grafanaAdminUser;
// Secret: reveal with `pulumi stack output grafanaPassword --show-secrets`.
export const grafanaPassword = pulumi.secret(grafanaAdminPassword.result);
export const serviceMonitors = [frontendServiceMonitor.metadata.name, redisServiceMonitor.metadata.name];
