# Hosting guide

Step-by-step instructions for hosting every part of this project on (mostly) free
services. Follows the plan: Cloudflare Pages for both frontends, Cloudflare R2 for
storage, GitHub Container Registry for images, one free Oracle Cloud VM for
`init-service`/`orchestrator-simple`, and a free `k3s` cluster (also on Oracle Cloud)
for the actual project pods.

Do these roughly in order — later steps depend on values (bucket name, VM IPs,
tokens) created in earlier ones.

---

## 0. Accounts you'll need

- A domain name (any registrar) — used for both `WS_DOMAIN`/`APP_DOMAIN` and the
  frontend URLs
- [Cloudflare](https://dash.cloudflare.com/sign-up) — free — for DNS, R2, Pages, and
  the Tunnel used in step 6
- [Oracle Cloud](https://signup.oraclecloud.com/) — free — for the always-free VMs.
  Requires a credit card for identity verification but the "Always Free" resources
  used here are never billed
- [GitHub](https://github.com) — you already have this — for GHCR (image registry)

---

## 1. Domain + Cloudflare DNS

1. Add your domain to Cloudflare ([dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site**) and update your
   registrar's nameservers to the two Cloudflare ones it gives you.
2. Decide your two project domains — they can be two subdomains of the same root
   domain, e.g.:
   - `WS_DOMAIN = ws.yourdomain.com`
   - `APP_DOMAIN = apps.yourdomain.com`
3. You'll add the actual DNS records for these once you have your cluster's IP
   (step 5) — skip ahead for now, just note the two domains you picked.

---

## 2. Cloudflare R2 (object storage)

This replaces AWS S3 — `S3_ENDPOINT` makes the existing S3 client code work against
it unchanged (see `init-service/src/aws.ts` / `runner/src/aws.ts`, both already use
`s3ForcePathStyle: true` for this).

1. Cloudflare dashboard → **R2** → **Create bucket**. Name it, e.g. `sandbox-scheduler`.
2. **R2** → **Manage API tokens** → **Create API token** → permission **Object Read & Write**, scoped to this bucket.
   Save the **Access Key ID** and **Secret Access Key** — these become
   `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` everywhere in this guide (the code
   just calls them that; they're really R2 credentials).
3. Your bucket's S3-compatible endpoint is shown on the bucket's **Settings** page:
   `https://<account-id>.r2.cloudflarestorage.com` — this is `S3_ENDPOINT`.
4. Seed the two base templates the platform copies from on project creation. From
   your machine, using the [`rclone`](https://rclone.org/) or `aws` CLI configured
   against the endpoint above:
   ```bash
   aws s3 cp --recursive ./base/node-js s3://sandbox-scheduler/base/node-js --endpoint-url https://<account-id>.r2.cloudflarestorage.com
   aws s3 cp --recursive ./base/python  s3://sandbox-scheduler/base/python  --endpoint-url https://<account-id>.r2.cloudflarestorage.com
   ```
   (`./base/node-js` and `./base/python` are whatever starter-project folders you
   want new projects seeded from — a `package.json` + `index.js` for node, a
   `requirements.txt` + `main.py` for python, etc.)

You now have: `S3_BUCKET`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`.

---

## 3. GitHub Container Registry (image registry)

Builds and pushes the three backend images. Run from the repo root.

```bash
echo $GITHUB_TOKEN | docker login ghcr.io -u <your-github-username> --password-stdin

docker build -t ghcr.io/<your-github-username>/runner:latest ./runner
docker push ghcr.io/<your-github-username>/runner:latest

docker build -t ghcr.io/<your-github-username>/init-service:latest ./init-service
docker push ghcr.io/<your-github-username>/init-service:latest

docker build -t ghcr.io/<your-github-username>/orchestrator-simple:latest ./orchestrator-simple
docker push ghcr.io/<your-github-username>/orchestrator-simple:latest
```

`$GITHUB_TOKEN` needs a [personal access token](https://github.com/settings/tokens)
with `write:packages` scope. After the first push, go to each package's GitHub page
→ **Package settings** → **Change visibility** → **Public** (otherwise your cluster
needs an `imagePullSecret` to pull them — public keeps this simple and free).

---

## 4. Provision the Oracle Cloud VMs

You'll create two kinds of instance from Oracle's **Always Free** tier:

- **1× AMD Micro VM** (`VM.Standard.E2.1.Micro`, 1GB RAM) — runs `init-service` +
  `orchestrator-simple`. Small, but they're lightweight Node processes.
- **1× Ampere A1 VM** (up to **2 OCPU / 12GB RAM total** — Oracle quietly halved
  this from 4 OCPU/24GB in June 2026, with no formal announcement) — runs the
  `k3s` Kubernetes cluster that actually schedules project pods. This is your
  whole free-tier Ampere allocation, so run it as a single instance/single-node
  cluster rather than splitting it across two smaller VMs.

**Region tip**: pick a region with 3 Availability Domains (e.g. **US East /
Ashburn**, **UK South / London**) — Ampere A1 capacity is genuinely
constrained on Oracle's free tier right now, and having multiple ADs to retry
across within one region matters more than which region you pick. If instance
creation fails with "Out of Capacity," retry in a different AD before trying a
different region entirely.

For each instance, in the Oracle Cloud console (**Compute** → **Instances** →
**Create instance**):

1. Choose **Canonical Ubuntu 22.04** as the image.
2. Under **Networking**, keep "Assign a public IPv4 address" checked.
3. Under **Add SSH keys**, upload your public key (`~/.ssh/id_ed25519.pub` or similar).
4. Create it, then note its **public IP**.

**Open the firewall** (Oracle blocks inbound traffic at two layers — both need
opening):

- **Console**: your VCN's **Security List** → add ingress rules allowing TCP `22`,
  `80`, `443` from `0.0.0.0/0` (and `6443` from your own IP only, for `kubectl`
  access to the k3s API).
- **On each VM itself** (Ubuntu's `iptables`/`netfilter` blocks these too, by
  default, separately from the console rule):
  ```bash
  sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
  sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
  sudo iptables -I INPUT -p tcp --dport 6443 -j ACCEPT
  sudo netfilter-persistent save   # or: sudo apt install iptables-persistent
  ```

---

## 5. Install k3s on the Ampere VM

SSH into the Ampere instance.

```bash
curl -sfL https://get.k3s.io | sh -
sudo cat /etc/rancher/k3s/k3s.yaml   # this is your kubeconfig
```

k3s ships with a built-in load balancer (**ServiceLB**, formerly Klipper) that
makes `type: LoadBalancer` Services work on bare VMs by binding the node's own
public IP — this is exactly why k3s (rather than plain `kubeadm`) is the right
choice for a free-VM cluster: `k8s/ingress-controller.yaml`'s `LoadBalancer`
Service will get an external IP (the node's own) with zero extra setup.

Copy the kubeconfig to your own machine so `kubectl` from your laptop (and later,
the scheduler VM) can reach it:

```bash
# on your machine
scp ubuntu@<ampere-vm-ip>:/etc/rancher/k3s/k3s.yaml ~/.kube/config-sandbox
sed -i "s/127.0.0.1/<ampere-vm-ip>/" ~/.kube/config-sandbox
export KUBECONFIG=~/.kube/config-sandbox
kubectl get nodes   # should show the one node, Ready
```

---

## 6. DNS — point your wildcard domains at the cluster

Cloudflare dashboard → **DNS** → add two records (replace with your actual chosen
subdomains from step 1):

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `*.ws` | `<ampere-vm-ip>` | **DNS only** (grey cloud) |
| A | `*.apps` | `<ampere-vm-ip>` | **DNS only** (grey cloud) |

**Important**: these must be **DNS only**, not proxied (orange cloud). Cloudflare's
proxy doesn't forward arbitrary subdomains to your own origin the way plain DNS
does here, and it doesn't support the WebSocket-heavy per-project traffic this
platform needs the way a direct connection does — the TLS termination for these is
handled by `cert-manager` instead (next section), not Cloudflare's proxy.

---

## 7. Install nginx-ingress and RBAC on the cluster

Still using `KUBECONFIG=~/.kube/config-sandbox`, from the repo root:

```bash
kubectl apply -f k8s/ingress-controller.yaml
kubectl apply -f k8s/rbac.yaml
```

Confirm the ingress controller got an external IP (should be the Ampere VM's own
IP, courtesy of ServiceLB):
```bash
kubectl get svc -n ingress-nginx ingress-nginx-controller
```

---

## 8. TLS via cert-manager

1. Install cert-manager:
   ```bash
   kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.14.5/cert-manager.yaml
   ```
2. Get a Cloudflare API token scoped to `Zone:DNS:Edit` for your domain: Cloudflare
   dashboard → profile icon → **My Profile** → **API Tokens** → **Create Token** →
   use the "Edit zone DNS" template, scope it to your domain.
3. Edit `k8s/cluster-issuer.yaml`: replace `your-cloudflare-api-token` with the
   real token, and `your-email@example.com` with your email.
4. Edit `k8s/wildcard-certificate.yaml`: replace `peetcode.com` / `autogpt-cloud.com`
   with your two actual domains from step 1.
5. Apply both:
   ```bash
   kubectl apply -f k8s/cluster-issuer.yaml
   kubectl apply -f k8s/wildcard-certificate.yaml
   kubectl get certificate -n ingress-nginx   # wait for READY=True, can take a minute or two
   ```
6. Uncomment the `--default-ssl-certificate=ingress-nginx/wildcard-tls` line near
   the bottom of `k8s/ingress-controller.yaml`'s args list, then re-apply:
   ```bash
   kubectl apply -f k8s/ingress-controller.yaml
   ```

Every `<replId>.<domain>` now gets HTTPS automatically, from this one cert.

---

## 9. Create the credentials Secret

Using the R2 credentials from step 2:

```bash
export AWS_ACCESS_KEY_ID=<your-r2-access-key-id>
export AWS_SECRET_ACCESS_KEY=<your-r2-secret-access-key>
export JWT_SECRET=$(openssl rand -hex 32)   # save this value — you'll need it again in step 11
./k8s/create-secret.sh
```

---

## 10. Configure and finish `service.yaml`

Edit `orchestrator-simple/service.yaml`:

- `image: 100xdevs/runner:latest` → `image: ghcr.io/<your-github-username>/runner:latest`
- `S3_BUCKET` value → your R2 bucket name
- `S3_ENDPOINT` value → your R2 endpoint from step 2
- In the `NetworkPolicy` block: the pod/service CIDR `except:` values — get your
  cluster's actual pod CIDR with:
  ```bash
  kubectl cluster-info dump | grep -m1 cluster-cidr
  ```
  (k3s defaults to `10.42.0.0/16` for pods and `10.43.0.0/16` for services — likely
  already correct unless you changed k3s's install flags, but confirm)

The `ingress-nginx` namespace label in the `NetworkPolicy` and the
`ws_domain_placeholder`/`app_domain_placeholder` Ingress hosts don't need editing —
those are substituted automatically at `/start` time.

---

## 11. Set up the scheduler VM (`init-service` + `orchestrator-simple`)

SSH into the **AMD Micro VM** from step 4.

```bash
# Node.js
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

git clone https://github.com/<your-username>/Ephemeral-Sandbox-Pod-Scheduler.git
cd Ephemeral-Sandbox-Pod-Scheduler
```

**Give this VM access to the k3s cluster** — copy the same kubeconfig you fetched
in step 5:
```bash
mkdir -p ~/.kube
scp <your-machine>:~/.kube/config-sandbox ~/.kube/config   # or scp directly from the Ampere VM
```
`@kubernetes/client-node`'s `loadFromDefault()` (used by `orchestrator-simple`)
picks up `~/.kube/config` automatically — no env var needed.

**init-service**:
```bash
cd init-service
npm install
npm run build
cp src/.env.example .env
```
Fill in `.env`:
```
S3_BUCKET=<your-r2-bucket>
AWS_ACCESS_KEY_ID=<your-r2-access-key-id>
AWS_SECRET_ACCESS_KEY=<your-r2-secret-access-key>
S3_ENDPOINT=<your-r2-endpoint>
JWT_SECRET=<same value from step 9>
OWNERSHIP_DB_PATH=/home/ubuntu/data/ownership.db
```

**orchestrator-simple**:
```bash
cd ../orchestrator-simple
npm install
npm run build
cp src/.env.example .env
```
Fill in `.env`:
```
JWT_SECRET=<same value as init-service, above>
OWNERSHIP_DB_PATH=/home/ubuntu/data/ownership.db
WS_DOMAIN=ws.yourdomain.com
APP_DOMAIN=apps.yourdomain.com
```
(Both services pointing at the same `OWNERSHIP_DB_PATH` on this one VM's local
disk is exactly the "shared filesystem" the README calls for — running both
services on one machine gets you that for free, no RWX storage needed.)

**Keep both processes running permanently** with `systemd`:

```bash
sudo tee /etc/systemd/system/init-service.service > /dev/null <<'EOF'
[Unit]
Description=init-service
After=network.target
[Service]
WorkingDirectory=/home/ubuntu/Ephemeral-Sandbox-Pod-Scheduler/init-service
ExecStart=/usr/bin/npm run start
Restart=always
User=ubuntu
[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/orchestrator-simple.service > /dev/null <<'EOF'
[Unit]
Description=orchestrator-simple
After=network.target
[Service]
WorkingDirectory=/home/ubuntu/Ephemeral-Sandbox-Pod-Scheduler/orchestrator-simple
ExecStart=/usr/bin/npm run start
Restart=always
User=ubuntu
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now init-service orchestrator-simple
sudo journalctl -u init-service -f    # tail logs to confirm it started (":3001")
sudo journalctl -u orchestrator-simple -f   # confirm ":3002", reaper + health monitor loops starting
```

---

## 12. Expose the scheduler VM publicly via Cloudflare Tunnel

`init-service`/`orchestrator-simple` are two fixed, single-purpose HTTP services —
unlike project subdomains, they don't need dynamic per-project routing, so a
**Cloudflare Tunnel** is a better (and free) fit than opening more ports on this
VM: no inbound firewall rules needed, automatic TLS, and it's tied to your same
Cloudflare account/domain from step 1.

On the scheduler VM:
```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb   # use -amd64 above if this VM is the AMD Micro shape, not arm64

cloudflared tunnel login                 # opens a link, authorize against your domain
cloudflared tunnel create scheduler
```

Create `~/.cloudflared/config.yml`:
```yaml
tunnel: scheduler
credentials-file: /home/ubuntu/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: init.yourdomain.com
    service: http://localhost:3001
  - hostname: api.yourdomain.com
    service: http://localhost:3002
  - service: http_status:404
```

Route DNS and run it as a service:
```bash
cloudflared tunnel route dns scheduler init.yourdomain.com
cloudflared tunnel route dns scheduler api.yourdomain.com
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

`init.yourdomain.com` and `api.yourdomain.com` are now live, over HTTPS, for free.

---

## 13. Deploy the frontend and landing page on Cloudflare Pages

Do this for **both** `frontend/` and `landing/` (two separate Pages projects).

Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to
Git** → pick this repo.

**For `frontend/`:**
- Root directory: `frontend`
- Build command: `npm run build`
- Build output directory: `dist`
- Environment variables (Pages project → **Settings** → **Environment variables**):
  ```
  VITE_INIT_SERVICE_URL=https://init.yourdomain.com
  VITE_ORCHESTRATOR_URL=https://api.yourdomain.com
  VITE_WS_DOMAIN=ws.yourdomain.com
  VITE_APP_DOMAIN=apps.yourdomain.com
  VITE_USE_TLS=true
  ```

**For `landing/`:**
- Root directory: `landing`
- Build command: `npm run build`
- Build output directory: `dist`
- No environment variables needed — it's static marketing content.

Both get a free `*.pages.dev` URL immediately; add a custom domain (e.g.
`yourdomain.com` for the landing page, `app.yourdomain.com` for the IDE frontend)
under each project's **Custom domains** tab — Cloudflare issues and manages that
TLS cert for you automatically.

---

## 14. Verify end-to-end

1. Open your frontend's URL, create a project — this hits `POST /project` on
   `init.yourdomain.com` (via the tunnel) → copies templates from R2.
2. It should then call `POST /start` on `api.yourdomain.com` → `orchestrator-simple`
   schedules a Deployment/Service/Ingress/NetworkPolicy on the k3s cluster.
3. Confirm the pod came up:
   ```bash
   kubectl get pods -A | grep sandbox-
   ```
4. The editor should connect over `wss://<replId>.ws.yourdomain.com` and the
   terminal/file sync should work.
5. Anything started on port 3000 in the terminal should be reachable at
   `https://<replId>.apps.yourdomain.com`.

If a project pod won't start, check:
```bash
kubectl describe pod -n sandbox-<replId>
kubectl logs -n sandbox-<replId> deploy/<replId>
```

---

## Cost recap

Everything above is $0/month except the domain registration itself
(~$10-15/year). The real ceiling isn't a bill — it's Oracle's free-tier capacity
(2 Ampere OCPUs / 12GB RAM total for the k3s cluster as of mid-2026, 1GB RAM for
the scheduler VM). `orchestrator-simple`'s capacity check (see README "Cluster
capacity & retries") will correctly return `503` rather than overloading the
node once you're out of room — that's your signal it's time to add a paid node,
not a sign something's broken.
