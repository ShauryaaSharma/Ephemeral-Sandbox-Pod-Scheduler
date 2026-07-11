# Ephemeral-Sandbox-Pod-Scheduler
Browser IDE that provisions a real, isolated Kubernetes pod per project on demand. init-service seeds the project into S3/R2; orchestrator-simple creates a Deployment/Service/Ingress via the k8s API; runner streams a live terminal (node-pty) and editor over Socket.IO; nginx-ingress routes each project by subdomain.
