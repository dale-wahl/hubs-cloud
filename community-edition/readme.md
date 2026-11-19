Important notes

Certificates renew automatically. cert-manager owns all four of them, so there is no
90-day renewal to do. **Do not run `npm run gen-ssl`**. That command and cert-manager would fight
over the same Secrets.

Initial admin, domain name and credentials go in `input-values.yaml`, then `gen-hcce`
generates `hcce.yaml` from it.

![Hubs Cloud Community Edition](https://uploads-prod.reticulum.io/files/05884d13-e5e8-4f64-9aca-792aae6d7734.png)

# Hubs Community Edition - Setup and Maintenance Guide

This guide covers deploying Hubs Community Edition on DigitalOcean Kubernetes, with DNS via Porkbun and transactional email via Scaleway.

---

## Contents

**Already running it? The two sections you want are
[Upgrading the application](#upgrading-the-application) and
[Updating the Cluster Configuration](#updating-the-cluster-configuration).**

| Setting it up | Running it |
|---|---|
| [Prerequisites](#prerequisites) | [**Upgrading the application**](#upgrading-the-application) |
| [1. Domain](#1-register-a-domain-porkbun) · [2. Email](#2-set-up-transactional-email-scaleway) | [**Updating the Cluster Configuration**](#updating-the-cluster-configuration) |
| [3. Cluster](#3-create-a-kubernetes-cluster-digitalocean) · [4. Tools](#4-install-command-line-tools) | [Certificates](#certificates) |
| [5. doctl](#5-connect-doctl-to-digitalocean) · [6. Configure](#6-configure-hubs) | [Syncing with Upstream](#syncing-with-upstream) |
| [7. Deploy](#7-deploy-to-kubernetes) · [8. DNS](#8-link-domain-to-cluster-porkbun-dns) | [Troubleshooting](#troubleshooting) |
| [9. Certificates](#9-certificates) · [10. Firewalls](#10-set-up-firewalls-digitalocean) · [11. Login](#11-first-login) | |

---

## Prerequisites

- A Porkbun account
- A Scaleway account
- A DigitalOcean account
- A registered domain name (see step 1)
- Windows, macOS, or Linux machine with command line access
- Node.js and git installed (step 6 needs `npm`)

---

## 1. Register a Domain (Porkbun)

1. Go to [Porkbun](https://porkbun.com) and create an account or log in.
2. Search for your desired domain name in the search bar on the homepage.
3. Select a top-level domain and add it to your cart. Approximate pricing:
   - `.com`: ~$10/year (first year often ~$1)
   - `.space`, `.site`: often under $2 for the first year
4. Complete checkout.

The domain will not resolve to anything yet. You will link it to DigitalOcean in a later step.

> Note: Porkbun may log you out during the purchase or DNS setup process. If buttons or fields stop responding, log back in and continue.

---

## 2. Set Up Transactional Email (Scaleway)

Hubs sends magic-link login emails to users via SMTP. Scaleway's Transactional Email service provides this. The free tier covers 300 emails per month (500 per month without identity verification, 5,000 per month with identity verification).

### Part 1: Create a Scaleway account

1. Go to [Scaleway Transactional Email](https://www.scaleway.com/en/transactional-email-tem/) and select **Sign up**.
2. Select **Personal project** as the account type.
3. Sign up with your email address, accept the Terms of Service and Data Protection Agreement, and confirm your email.
4. Fill in your first name, last name, and billing address.
5. Add a payment method (credit card required). Scaleway charges a one-time 1 EUR verification fee. The 4-digit verification code appears in the transaction description on your bank statement or card app, in the format `SCW* C-XXXX`.
6. Create your first project. Give it a recognizable name such as `HubsCEProject`.
7. Select **Other or I don't know** for project use case and click **Start working**.

### Part 2: Add your domain to Scaleway

8. In the Scaleway console sidebar, go to **Domains & Web Hosting > Transactional Email**.
9. Click **Add domain**.
10. Under **Add a domain external to Scaleway**, enter your Porkbun domain (e.g. `yourcoolhubs.space`). Domain names may only contain alphanumeric characters, dots, and dashes.
11. Enter an estimated monthly email count beyond 300 (you can enter 0 if unsure).
12. Click **Validate domain name**.
13. On the next page, **Configure your DNS records manually** will be selected by default. Leave it as-is. Scaleway will show you the values for four DNS records: SPF, DKIM, MX, and DMARC. Keep this page open, you will need these values in the next step.

### Part 3: Add DNS records at Porkbun

14. Log in to [Porkbun](https://porkbun.com), go to **Account > Domain Management**, find your domain, and click **Details**.
15. Click the **DNS Records** edit icon to open the DNS management popup.
16. Delete any existing default records that contain the word "pixie" by clicking the trashcan icon next to them.
17. Add the following four records by copying values from the Scaleway page. For each record, set **TTL** to 600 and leave **Priority** blank unless otherwise noted.

**SPF record:**
- Type: `TXT`
- Host: leave blank (root domain)
- Answer/Value: paste the SPF value from Scaleway (`v=spf1 include:_spf.tem.scaleway.com -all`)

**DKIM record:**
- Type: `TXT`
- Host: paste the Name value from Scaleway. Porkbun auto-appends your domain to the Host field, so if the Scaleway name ends with your domain (e.g. `xxxxxxx._domainkey.yourcoolhubs.space`), paste only the part before your domain (e.g. `xxxxxxx._domainkey`). Delete any trailing domain text if it appears after pasting.
- Answer/Value: paste the DKIM value from Scaleway

**MX record:**
- Type: `MX`
- Host: leave blank
- Answer/Value: `blackhole.tem.scaleway.com.` (include the trailing dot)
- Priority: `10`

**DMARC record:**
- Type: `TXT`
- Host: `_dmarc`
- Answer/Value: paste the DMARC value from Scaleway

18. Back at Scaleway, check the box **I have added these DNS records to my DNS zone** and click **Verify domain**. Verification can take up to 48 hours, but is often completed within minutes. Scaleway sends a confirmation email when the domain is verified.

### Part 4: Retrieve your SMTP credentials

19. In the Scaleway console, go to **Transactional Email > your domain > Overview**. Note down:
   - **SMTP Server**: `smtp.tem.scaleway.com`
   - **SMTP Port**: `2587` (use this port, not 587, as Kubernetes providers including DigitalOcean may block port 587)
   - **Username**: your Scaleway **Project ID**, shown in the SMTP configuration section of the Overview tab
20. Go to **IAM > API Keys** and generate an API key for your project. Note down the **secret key** -- this is your SMTP password and will not be shown again.

---

## 3. Create a Kubernetes Cluster (DigitalOcean)

1. Sign up or log in at [DigitalOcean](https://www.digitalocean.com).
2. In the left sidebar, click **Kubernetes** under Manage.
3. Click **Create a Kubernetes Cluster** and configure:
   - **Version**: select the recommended version
   - **Datacenter region**: choose the location closest to your users
   - **VPC Network**: leave as default
   - **Cluster capacity**:
     - Node type: Shared CPU, Basic
     - Plan: $24/month
     - Autoscale: off
     - Nodes: 1 (single-node clusters are more stable on DigitalOcean)
     - Minimum RAM: 4 GB (required for Hubs to run)
4. Give the cluster a name and click **Create cluster**.

---

## 4. Install Command Line Tools

### kubectl

Install kubectl for your operating system:

- **Windows**: https://kubernetes.io/docs/tasks/tools/install-kubectl-windows/
- **macOS/Linux**: follow the options in the sidebar at the link above

Verify the installation:

```bash
kubectl version
```

Expected output: a Client version and a Kustomize version.

### doctl

1. Visit the [doctl releases page](https://github.com/digitalocean/doctl/releases) and download the version for your system (e.g. Windows-AMD64).
2. Extract the `.zip` file and place the extracted files in a short path such as `C:\code`.
3. Add the folder to your system PATH:
   - Search for **environment variables** in the Windows search bar
   - Open **Environment Variables**
   - Under **User variables**, select **Path** and click **Edit**
   - Click **New** and paste the folder path (e.g. `C:\code`)
   - Click OK to confirm

Verify the installation:

```bash
doctl version
```

Expected output: a doctl version number and a Git commit hash.

---

## 5. Connect doctl to DigitalOcean

1. In the DigitalOcean sidebar, scroll to the bottom and click **API**.
2. Click **Generate New Token**:
   - Expiration: No expire
   - Scope: Full Access
3. Copy and save the token -- it will not be shown again.
4. In your terminal, run:

```bash
doctl auth init --context HubsContext
```

Enter the token when prompted.

5. Switch to the new context:

```bash
doctl auth switch --context HubsContext
```

6. Go back to your cluster in DigitalOcean, navigate to step 2 **Connecting to Kubernetes**, and copy and run the authentication command shown there.

---

## 6. Configure Hubs

1. Clone **this** repository — `4D-Research-Lab/hubs-cloud` — and open the
   `community-edition` folder. Not `Hubs-Foundation/hubs-cloud`: this fork carries the
   automatic certificate renewal, the credential handling and several fixes upstream does
   not have.
2. Copy the template and fill it in:

```bash
cp input-values.yaml.example input-values.yaml
```

| Field | Value |
|---|---|
| `HUB_DOMAIN` | Your Porkbun domain, e.g. `yourcoolhubs.space` |
| `ADM_EMAIL` | Your admin email address |
| **`PERSISTENT_VOLUME_STORAGE_CLASS`** | **`do-block-storage-retain`** — see the warning below |
| `SMTP_SERVER` | `smtp.tem.scaleway.com` |
| `SMTP_PORT` | `2587` |
| `SMTP_USER` | Your Scaleway Project ID |
| `SMTP_PASS` | Your Scaleway API secret key |
| `NODE_COOKIE`, `GUARDIAN_KEY`, `PHX_KEY` | Random strings — `openssl rand -base64 32` |
| `DB_PASS` | A password you choose. **Do not leave the placeholder.** |

> ### ⚠️ `PERSISTENT_VOLUME_STORAGE_CLASS` is the field that destroys data if you get it wrong
>
> If it is absent, the generator defaults it to `manual`, which stores the database and
> every uploaded file in **plain directories on the node's own disk**. A managed
> Kubernetes provider replaces that node from time to time — routine upgrades do it — and
> the replacement arrives with those directories empty. Every pod reports healthy and
> nothing errors anywhere, but the data is gone.
>
> **That happened to this instance on 21 September 2026 and everything was lost.** Set it
> to a real storage class. `kubectl get storageclass` lists what your cluster offers; on
> DigitalOcean, `do-block-storage-retain` also keeps the disk if the claim is ever
> deleted.

Optionally, add API tokens for SketchFab and Tenor in their respective fields.

3. Open a terminal in the `community-edition` folder and run:

```bash
npm ci
npm run gen-hcce
```

This generates **two** files from your input values:

- `hcce.yaml` — everything except credentials. Safe to re-apply any time.
- `hcce-secret.yaml` — the passwords and keys.

They are separate because `gen-hcce` mints a fresh encryption keypair on every run. If
they were one file, re-applying it would replace the live credentials with new ones. Both
are gitignored; never commit either.

---

## 7. Deploy to Kubernetes

Navigate to the `community-edition` folder in your terminal:

```bash
cd /path/to/hubs-cloud/community-edition
```

Apply the configuration to the cluster:

```bash
npm run apply
```

**Use `npm run apply`, not `kubectl apply -f hcce.yaml` directly.** They are not the same.
`npm run apply` first shows you `kubectl diff` and refuses to proceed until you pass
`--yes`, and it creates the credentials Secret on a first install. A raw `kubectl apply`
does neither — on 18 November 2026 it broke TLS on the live site by applying a template
setting the cluster had never had.

Verify the deployment:

```bash
kubectl get deployment -n hcce
```

Wait a few minutes until all pods show `1/1` under the **Ready** column. This means all components have started without errors.

---

## 8. Link Domain to Cluster (Porkbun DNS)

Get the external IP address of the load balancer:

```bash
kubectl -n hcce get svc lb
```

Copy the value under **External-IP**. Then:

1. Log in to Porkbun, go to **Account > Domain Management**, find your domain, and click **Details**.
2. Click the **DNS Records** edit icon to open the DNS management popup.
3. Create four A records with the following settings:
   - **Type**: A
   - **TTL**: 600
   - **Answer/Value**: the External-IP from above
   - **Host values**: *(leave blank)*, `assets`, `stream`, `cors`

These four records allow the domain and its required subdomains to reach the Hubs instance.

---

## 9. Certificates

**There is nothing to do here.** cert-manager issues and renews all four certificates
automatically, and the `ret` ingress is already annotated to make that happen.

**Do not run `npm run gen-ssl`.** It and cert-manager would fight over the same Secrets.

Within a couple of minutes of step 8 (DNS), all four should report `True`:

```bash
kubectl get certificate -n hcce
```

If one stays `False`, the cause is usually DNS -- the ACME challenge needs your domain
resolving to the load balancer. Check the A records from step 8, then see
[A certificate is not being issued](#a-certificate-is-not-being-issued).

> **Setting up a brand-new cluster?** cert-manager has to be installed first; it is not
> part of `hcce.yaml`. The operations notes (`reference/certificates.md`) have the
> one-time install, including a staging-first step so a mistake does not burn Let's
> Encrypt's rate limits.

---

## 10. Set Up Firewalls (DigitalOcean)

1. In DigitalOcean, go to **Networking > Firewalls** in the left sidebar.
2. Click **Create Firewall** and add three Inbound Rules:

| Protocol | Port |
|---|---|
| TCP | 4443 |
| TCP | 5349 |
| UDP | 35000-60000 |

3. Under **Apply to Droplets**, type the first letter of your node pool name to find it and apply the firewall.

Hubs is now fully operational.

---

## 11. First Login

1. Visit your domain and click **Sign in / Sign up**.
2. Enter the admin email address you configured.
3. Use the magic link sent to your email to log in.
4. The **Admin** option will appear on the Hubs homepage.

---

## Maintenance

### Certificates

**Nothing to do. They renew themselves.** cert-manager renews roughly 30 days before
expiry, retries on failure, and keeps its ACME account key, so nothing is reissued from
scratch. The 90-day `npm run gen-ssl` routine this section used to describe is gone, and
**running `gen-ssl` now would fight cert-manager over the same Secrets.**

```bash
kubectl get certificate -n hcce
```

All four should say `True`. To check what browsers actually receive:

```bash
echo | openssl s_client -connect virtualplaces-uva.eu:443 -servername virtualplaces-uva.eu 2>/dev/null | openssl x509 -noout -issuer -dates
```

The issuer should say **Let's Encrypt**. If it names the site itself, the self-signed
fallback is being served -- see
[Browser shows a security warning](#browser-shows-a-security-warning).

### Syncing with Upstream

> **Corrected 18 November 2026.** This section used to say a GitHub Actions workflow ran
> every Monday to merge upstream changes, and to trigger it from **Actions > Sync
> Upstream**. **No such workflow exists, and none ever has** -- the repository has two
> workflows and neither is it. Nothing was watching upstream, which is a large part of why
> this fork sat 19 commits behind while the server ran a two-year-old build. **Do not rely
> on an automatic sync; there isn't one.**

Syncing is manual. From the repository root:

```bash
git fetch upstream && git log --oneline master..upstream/master
```

Nothing printed means you are up to date. Commits printed are worth reading before
merging, and occasionally urgent: upstream's `3f74c73` fixed a Kubernetes 1.34 memory
problem that cost this instance a day of debugging two months after it was published.

**That check is the thing most worth automating, and it is not done yet.** Note that a
"how far is upstream ahead" check would **not** have caught the bug that pinned this
instance to a dead image for fifteen months -- that was a local commit reverting an
upstream fix, which is invisible to `master..upstream/master`. Catching that needs a diff
of `input-values.yaml.example` against upstream's `input-values.yaml`.

Expect conflicts in `generate_script/hcce.yam`, `readme.md` and `input-values.yaml`. Every
fork-local change in the templates has a comment above it saying what it is for and what
breaks without it, so the file itself tells you whether to keep ours.

> **`input-values.yaml` is not tracked by git** -- it holds live credentials, and a
> filled-in copy was once committed to this public repository by accident. So a merge from
> upstream reports it as *"deleted by us, modified by them"* rather than a normal
> conflict. **The answer is always: keep it deleted.** If upstream added a genuinely new
> setting, copy that one line into `input-values.yaml.example` and into your own
> `input-values.yaml`.

### Upgrading the application

The six Hubs Foundation images are pinned to exact builds in `input-values.yaml`, so
nothing moves unless someone decides it should. To move one:

1. Find the current build number on Docker Hub — e.g.
   https://hub.docker.com/r/hubsfoundation/reticulum/tags — and look for the newest
   `stable-NNN`.
2. Change that one line in `input-values.yaml`, so the file records what is running.
3. Apply it to the cluster, one service at a time:

```bash
kubectl set image deploy/reticulum reticulum=hubsfoundation/reticulum:stable-860 -n hcce
```

```bash
kubectl rollout status deploy/reticulum -n hcce --timeout=300s
```

Check the site between each one. **To undo, run the same command with the old build
number** — the old image is still cached on the node, so it comes back in seconds.

Services and their images: `reticulum`, `hubs`, `spoke`, `dialog`, `nearspark`,
`photomnemonic` are all `hubsfoundation/<name>`. `coturn`, `haproxy`, `pgsql`,
`pgbouncer`, `pgbouncer-t` and `postgrest` are `mozillareality` images with no Hubs
Foundation replacement — leave them.

**Do not restart `coturn` with `kubectl rollout restart`.** It binds a fixed host port and
the replacement pod can never take it from the old one, so the rollout hangs forever. Use
`kubectl scale deploy coturn --replicas=0 -n hcce` then `--replicas=1`.

### Updating the Cluster Configuration

After any change to `input-values.yaml` or `hcce.yaml`:

```bash
npm run gen-hcce
npm run apply
```

That is safe to run as often as you like. `hcce.yaml` holds no credentials, so applying it
cannot disturb them, and `npm run apply` only applies `hcce-secret.yaml` if the cluster has
no credentials yet — a first install.

**If you changed a password or key** in `input-values.yaml`, that is the one case needing
an extra step, because the cluster will not pick it up otherwise:

```bash
kubectl apply -f hcce-secret.yaml
kubectl rollout restart deploy/reticulum deploy/dialog -n hcce
```

Restart **both**. They share a key, and if only one restarts they disagree about it and
voice stops working — with nothing in the logs to say why.

---

## Troubleshooting

### Pods not reaching 1/1 after deployment

Check the status of all pods:

```bash
kubectl get pods -n hcce
```

View logs for a specific pod (replace `<pod-name>` with the name from the above output):

```bash
kubectl logs <pod-name> -n hcce
```

Common causes:
- Incorrect values in `input-values.yaml` (SMTP credentials, domain name)
- Cluster has insufficient RAM (minimum 4 GB required)
- The cluster is still starting up -- wait a few more minutes

### Domain does not resolve to Hubs

- Verify the four A records exist in Porkbun DNS (blank host, `assets`, `stream`, `cors`)
- Confirm the IP in the records matches the current load balancer IP:

```bash
kubectl -n hcce get svc lb
```

- DNS changes can take a few minutes to propagate. Porkbun's minimum TTL is 600 seconds.

### Browser shows a security warning

Find out which certificate is actually being served:

```bash
echo | openssl s_client -connect virtualplaces-uva.eu:443 -servername virtualplaces-uva.eu 2>/dev/null | openssl x509 -noout -subject -issuer
```

- **`issuer` says Let's Encrypt** -- the certificate is fine. Clear the browser cache or
  try a private window.
- **`issuer` matches `subject`** (both your domain) -- the **self-signed** `cert-hcce` is
  being served instead of the real ones, which means haproxy has been given
  `--default-ssl-certificate`. That flag is deliberately **not** in this fork's template;
  if it is back, a merge from upstream reintroduced it. Remove it and re-apply, or
  `kubectl rollout undo deploy/haproxy -n hcce`.
- **a certificate shows `False`** in `kubectl get certificate -n hcce` -- it has not been
  issued; see [A certificate is not being issued](#a-certificate-is-not-being-issued).

This exact failure happened on 18 November 2026, and the site answered HTTP 200 throughout
-- nothing looked wrong from inside the cluster. **Check from outside.**

### A certificate is not being issued

**Do not run `npm run gen-ssl`** -- cert-manager owns these and the two would fight.

```bash
kubectl get certificate -n hcce
kubectl describe certificaterequest -n hcce | tail -40
```

Usual causes:

- The Porkbun A records no longer point at the load balancer's External-IP, so the ACME
  challenge cannot reach the cluster
- The cluster is not fully online (`kubectl get pods -n hcce`)
- The `cert-manager.io/cluster-issuer` annotation has gone from the `ret` ingress. A
  regeneration from an older template does this, and it fails **silently** -- no error,
  renewals just stop. Check it is there:

```bash
kubectl get ingress ret -n hcce -o jsonpath='{.metadata.annotations}'
```

### Magic link emails are not arriving

- Confirm your Scaleway domain shows as verified in the Transactional Email dashboard
- Confirm `SMTP_PORT` is set to `2587`, not `587`
- Confirm `SMTP_USER` is your Scaleway **Project ID**, not your email address or account name
- Confirm `SMTP_PASS` is your Scaleway **API secret key**
- Check your Scaleway Transactional Email dashboard for delivery errors or bounces
- Scaleway's free tier is capped at 300 emails per month (500 without identity verification, 5,000 with). If you have exceeded this quota, emails will not be sent.

### SMTP port blocked by DigitalOcean

DigitalOcean and other Kubernetes providers may block port 587. Always use port `2587` with Scaleway, which is provided specifically as a fallback for this reason.

### Scaleway domain verification is pending or failing

Domain verification can take up to 48 hours, though it is usually quick. If verification fails, Scaleway sends an email with the specific error. Common causes:
- A DNS record was entered with incorrect formatting in Porkbun
- The DKIM Host field includes the full domain suffix -- Porkbun appends the domain automatically, so if you included it manually, remove it from the Host field and save again
- Records have not yet propagated -- wait a few minutes and click **Verify domain** again at Scaleway

### Firewall issues (multiplayer not working)

Confirm the three inbound rules are applied to the correct node pool in DigitalOcean:

| Protocol | Port |
|---|---|
| TCP | 4443 |
| TCP | 5349 |
| UDP | 35000-60000 |

### doctl authentication fails

Re-authenticate with a fresh token:

```bash
doctl auth init --context HubsContext
```

If the context already exists, remove it first:

```bash
doctl auth remove --context HubsContext
doctl auth init --context HubsContext
```

### kubectl cannot connect to cluster

Re-run the cluster authentication command from DigitalOcean:

1. Go to your cluster in the DigitalOcean console
2. Navigate to **Connecting to Kubernetes** (step 2)
3. Copy and run the command shown there

Verify connectivity:

```bash
kubectl get nodes
```


<!-- ------------------------------------------------------------------------
     4D-SPECIFIC CONTENT ENDS HERE. Everything BELOW is upstream's readme.

     If a merge from upstream conflicts in this file: keep everything above
     this marker, take upstream's version of everything below it.
     ------------------------------------------------------------------------ -->

# Hubs Cloud Community Edition

Community Edition is a free tool designed to help developers deploy the full Hubs stack on cloud computing software of their choosing. Community Edition simplifies and automates most of the complex deployment process using [Kubernetes](https://kubernetes.io/), a containerized software orchestration system.

Community Edition is designed for developers capable of working with the full Hubs stack and of navigating complex application infrastructure. With Community Edition, developers are responsible for designing, building, hosting, and maintaining their software throughout its lifetime. In order to create a production-ready version of Hubs similar to Hubs Cloud, Developers using Community Edition will need to implement additional features and customizations outside of those listed in this repo. See ["Considerations for Production Environment"](https://github.com/mozilla/hubs-cloud/tree/master/community-edition#considerations-for-production-environment) for more details.

## Why Kubernetes

[Kubernetes](https://kubernetes.io/) is an industry standard for allowing developers to build, deploy, and scale applications efficiently and reliably. Benefits to Kubernetes include:

- [Portability, Extensibility, and Open Source](https://kubernetes.io/docs/concepts/overview/)
- [Availability in many cloud environments](https://kubernetes.io/docs/setup/production-environment/turnkey-solutions/)
- Many options for single server deployments, such as [Minikube](https://minikube.sigs.k8s.io/docs/start/), [K3s](https://k3s.io/), [Microk8s](https://microk8s.io/), and [kind](https://kind.sigs.k8s.io/)

## Prerequisites


- Node.js installed on your system. You can download it from [here](https://nodejs.org/).
- Clone the repository:
   ```sh
   git clone https://github.com/hubs-foundation/hubs-cloud
   ```
- Navigate to the project directory:
   ```sh
   cd hubs-cloud/community-edition
   ```
- Install the module dependencies:
   ```sh
   npm ci
   ```
Before applying the configuration file to your Kubernetes cluster, you will need to choose and configure the following services...
- A hosting service with a Kubernetes cluster to receive your Community Edition deployment spec.
- Kubernetes controls on your device. Install kubectl to interact with your Kubernetes cluster from [here](https://kubernetes.io/docs/tasks/tools/#kubectl)
- A DNS service to reach Hubs on a domain
- Port to expose services to client
  - TCP: 80, 443, 4443, 5349
  - UDP: 35000 -> 60000
- An SMTP service for login emails and accounts


## Deploy to Kubernetes

To deploy to your K8s cluster on your chosen hosting solution, follow these steps:

- In `input-values.yaml` edit `HUB_DOMAIN`, `ADM_EMAIL`, `SMTP_SERVER`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and optionally `SKETCHFAB_API_KEY` with the values for your site.  Change `NODE_COOKIE`, `GUARDIAN_KEY`, & `PHX_KEY` to unique random values, using a password generator if you have one handy.
For a single-node test (not production) instance, you can set `PERSISTENT_VOLUME_STORAGE_CLASS` to `manual` to save a few bucks.
For a custom setup, you can set `PERSISTENT_VOLUME_STORAGE_CLASS` to any storage class supported on your cluster.
- Run `npm run gen-hcce && npm run apply` to generate your configuration in `hcce.yaml` and apply it to your K8s cluster. From the output read your load balancer's external IP address.
- Expose the services
  - On your DNS service, create four A-records to route your domains to the external IP address of your load balancer
    - <root_domain>
    - assets.<root_domain>
    - stream.<root_domain>
    - cors.<root_domain>

- Configure your HTTPS certs
  - Option #1: bring your own
    - package the certs into kubernetes secrets named `cert-<domain>` under the deploy namespace
  - Option #2: use Hubs' certbotbot
    - run `npm run gen-ssl` to get an SSL certificate provisioned for your domains
      - If it fails with an error like `namespaces "hcce" not found`, it's probably because the namespace hasn't finished generating from your initial application of the hcce.yaml file, so try running it again in a few seconds.
    - Search for and comment out the `--default-ssl-certificate` line in `hcce.yaml` and then reapply `hcce.yaml` to kubernetes using `npm run apply`


## Managing Kubernetes

While working with Community Edition and kubernetes you will likely need to perform debugging and maintenance on your cluster, we have found these commands useful to this process.


### Info Commands
- `kubectl config current-context` - Displays the current context.
- `kubectl get ingress -n hcce` - Shows information about which of your pods are connected to the internet and how.
- `kubectl get secrets -n hcce` - Used to get information on your SSL certificates.
- `kubectl get deployment -n hcce` - Used to list the services of your kubernetes deployment and their status.
- `kubectl describe deployment <servicename> -n hcce` - Used to get information on a service in your deployment.
- `kubectl get pods -n hcce` - Used to list your pods and their status.
- `kubectl describe pod <podname> -n hcce` - Used to get information about a pod.  This includes which containers it has.
- `kubectl logs <podname> -n hcce` - Used to get the logs from a pod.
- `kubectl logs <podname> <containername> -n hcce` - Used to get the logs from a container within the pod.
- `kubectl top pods -n hcce` - Used to get information on the CPU, Memory, etc. of all your pods.
                               This may require additional configuration on your kubernetes provider to be used.
- `kubectl top pod <podname> -n hcce` - Used to get information on the CPU, Memory, etc. of a specific pod.
                                        This may require additional configuration on your kubernetes provider to be used.
- `kubectl get svc lb -n hcce` - Used to get info on your load balancer, IP addresses, ports, etc..
- `kubectl get pv -n hcce` - Used to list your persistent volumes.
- `kubectl describe pv <pv-name> -n hcce` - Used to get info on a persistent volume.
- `kubectl get pvc -n hcce` - Used to list your persistent volume claims.
- `kubectl describe pvc <pvc-name> -n hcce` - Used to get info on a persistent volume claim.

### Action Commands
- `kubectl apply -f hcce.yaml` - Used to apply your hcce.yaml config file to your kubernetes cluster.  This will update/create deployments and pods.
- `kubectl rollout restart deployment -n hcce` - Used to gracefully restart your deployment.
- `kubectl delete deployment --all -n hcce` - Used to delete all the services in your deployment.
- `kubectl delete deployment/<servicename> -n hcce` - Used to delete a specific service in your deployment.
- `kubectl delete pods --all -n hcce` - Used to delete all of your pods.
- `kubectl delete pod <podname> -n hcce` Used to delete a specific pod.
- `kubectl set image deployment/<servicename> <containername>=<dockerimage> -n hcce` - Used to set a docker image to one of your pods.  You will need to restart the deployment or delete the pod afterwards.
  - Example: `kubectl set image deployment/hubs hubs=hubsfoundation/hubs:stable-latest -n hcce`
- `kubectl scale deployments --all --replicas=0 -n hcce` - Used to scale down your kubernetes cluster, i.e. turn it off.
- `kubectl scale deployments --all --replicas=1 -n hcce` - Used to scale up your kubernetes cluster, i.e. turn it on.
> [!NOTE]
> Turning your kubernetes cluster off and on again can sometimes fix things when they're acting weird, e.g. if Spoke is displaying failed to fetch errors when uploading files.


### Graphical Clients

Kubernetes clusters can also be managed via GUI programs.  Here are some possibilities:

- [Podman Desktop](https://podman-desktop.io/) - Versions 1.8+.  Recent versions of Podman Desktop have both docker and kubernetes support.
- [Seabird](https://getseabird.github.io/)
- [K9s](https://k9scli.io/) - Terminal UI.
- [Headlamp](https://headlamp.dev/)
- [JET Pilot](https://www.jet-pilot.app/)


## Operations

If you need to edit `hcce.yaml` directly, for example
1. To have your cluster pull a fresh image whenever you deploy, change `imagePullPolicy` to `Always` for that image.
2. To work around certain SSL issues, comment out the line `- --default-ssl-certificate=hcce/cert-hcce`

After saving `hcce.yaml`, run

`npm run apply`

then

`kubectl get pods -n hcce`

If you just need to get the external IP address of your load balancer, run

`npm run get-ip`

### Backing up and restoring your instance

Use `npm run backup` to back up your instance.  The backup will be timestamped and placed in a `data_backups` folder.

Use `npm run restore-backup data_backup_1234567890123` to restore a backup to your instance.  If you don't specify a backup, and just use `npm run restore-backup`, it will default to the latest backup.
The `hcce.yaml` file in the `community-edition` directory must match your instance.

If you run an external database instead of the `pgsql` pod, the scripts will only back up and restore the reticulum files.

## Guides from the Hubs Team and Community

### 1. Beginner's Guide to CE

The [Beginner's Guide to CE](https://docs.hubsfoundation.org/beginners-guide-to-CE.html) takes you through the process of setting up Hubs, and all of it's required services, using the current Node.js version of Community Edition.  It is targeted at beginners, people without any programming experience, and the Windows operating system, but it should be useful to experienced developers, and those on other operating systems as well.  It uses DigitalOcean (for a kubernetes cluster), Porkbun (for the domain), and Scaleway (for the transactional email/smtp) as the additional services required by Hubs.

### 2. Deploying A "Hello-World" Instance Using Managed Kubernetes on GCP with AWS' DNS & SMTP

> [!IMPORTANT]
> This guide is based on the bash version of Community Edition, to follow along you will need to use the bash scripts from https://github.com/Hubs-Foundation/hubs-cloud/tree/bash-version

[The Hubs Team's case study](https://hubs.mozilla.com/labs/community-edition-case-study-quick-start-on-gcp-w-aws-services/) outlines the process of deploying your first, experimental instance on GCP's GKS. This tutorial walks you through the process of setting up DNS on AWS Route 53 and SMTP on AWS SES, deploying and trouble-shooting your instance on GCP, and configuring custom code & server settings.\
[Companion Video](https://youtu.be/8XNEWmf9tk4)

### 3. Community Edition Tips and Tricks by [@kfarr](https://github.com/kfarr)

> [!IMPORTANT]
> This guide is based on the bash version of Community Edition, to follow along you will need to use the bash scripts from https://github.com/Hubs-Foundation/hubs-cloud/tree/bash-version

[Documentation Awardee Kieran Farr's guide](https://hubs.mozilla.com/labs/tips-and-tricks-for-deploying-hubs-community-edition-to-google-cloud-platform/) shares the helpful tips and tricks he learned while following the Hubs Team's case study on GCP. This is an excellent repository of helpful commands and debugging techniques for new Kubernetes users.
[Companion Video](https://youtu.be/w4NlAhKaBrg)

### 4. Community Edition Helm Chart by [@Doginal](https://github.com/Doginal)

Documentation Awardee Alex Griggs maintains [an open-source Helm Chart for HCCE](https://github.com/hubs-community/mozilla-hubs-ce-chart). Helm is an abstraction above Kubernetes that improves maintainability, scalability, and ease-of-use of applications using K8s. Alex has also released three tutorials showing how to use his Helm chart to create production-ready CE deployments, including for large scale events:

1. [Deploying Mozilla Hubs CE on AWS with Ease: A Guide to the Personal Edition Helm Chart](https://hubs.mozilla.com/labs/deploying-mozilla-hubs-ce-on-aws-with-ease-a-guide-to-the-personal-edition-helm-chart/)
2. [Deploying Mozilla Hubs CE on AWS with Ease: A Guide to the Scale Edition Helm Chart](https://hubs.mozilla.com/labs/deploying-mozilla-hubs-ce-on-aws-with-ease-a-guide-to-the-scale-edition-helm-chart/)
3. [Deploying Mozilla Hubs CE on GCP with Ease: A Guide to the Personal Edition Helm Chart](https://hubs.mozilla.com/labs/deploying-mozilla-hubs-ce-on-gcp-with-ease-a-guide-to-the-personal-edition-helm-chart/)\

[AWS Companion Video](https://youtu.be/0VtKQYXTrn4)\
GCP Companion Video (Coming Soon!)

### 5. Azure Hubs Community Edition Installation by [@TophoStan](https://github.com/TophoStan)

> [!IMPORTANT]
> This guide is based on the bash version of Community Edition, to follow along you will need to use the bash scripts from https://github.com/Hubs-Foundation/hubs-cloud/tree/bash-version

Documentation Awardee Stan Tophoven has published steps for uploading a Community Edition instance to Microsoft Azure's managed Kubernetes Platform.

1. [Installing Community Edition on Microsoft Azure AKS](https://hubs.mozilla.com/labs/installing-mozilla-hubs-community-edition-on-your-own-microsoft-azure-kubernetes-service/)
2. [Stan Tophoven's Guide to Deploying Community Edition on Azure AKS](https://www.youtube.com/watch?v=j8dQEEEX4OA)

### 6. Community Edition Setup on OVH by [@utopiah](https://fabien.benetou.fr/Tools/HubsSelfHosting)

> [!IMPORTANT]
> This guide is based on the bash version of Community Edition, to follow along you will need to use the bash scripts from https://github.com/Hubs-Foundation/hubs-cloud/tree/bash-version

Documentation Awardee Fabien Benetou has produced a guide for hosting Community Edition on OVH, including some excellent information on setup time, cost considerations, custom client deployment, and how Hubs can live on beyond Mozilla! Fabien has also produced long form and short form tutorial videos, including one in French.

1. [Written Document](https://fabien.benetou.fr/Tools/HubsSelfHosting)
2. [Long Form Tutorial in English](https://video.benetou.fr/w/c5YUiW7xaKAx91GPbCvWxd)
3. [Long Form Tutorial in French](https://video.benetou.fr/w/o8MDuxro6vaiT7Bu3PdyVw)
4. [Short Form Tutorial in English](https://video.benetou.fr/w/1vJC37pEhkEqJv6wU1h1c8)
5. [Custom Client Deployment](https://video.benetou.fr/w/qUkZiRTXGnu2xXXudJyPxM)

### 7. Azure Hubs Community Edition Installation by [@vvdt](https://github.com/vvdt)

> [!IMPORTANT]
> This guide is based on the bash version of Community Edition, to follow along you will need to use the bash scripts from https://github.com/Hubs-Foundation/hubs-cloud/tree/bash-version

Community Mamber Vincent van den Tol has released [instructions for installing Community Edition on Microsoft Azure](https://github.com/imedu-vr/hubs-docs/blob/main/azure_hubs_ce_installation.md), including persistent volumes, custom client deployment, and many helpful tips and tricks.

### 8. Import Assets from Hubs Cloud to CE by [chris-metabi](https://github.com/chris-metabi)

Chris from MeTabi [has created a guide](https://github.com/hubs-community/import_assets) for copying data from an existing Hubs Cloud instance and porting it to a Community Edition instance.

### 9. A "Hello-World" Instance With VM On GCP

> [!IMPORTANT]
> This guide is based on the bash version of Community Edition, to follow along you will need to use the bash scripts from https://github.com/Hubs-Foundation/hubs-cloud/tree/bash-version

##### Step 1: Make a kubernetes environment

Replace `hcce-vm-1` and `us-central1-a` with your desired name and zone. Check [the official doc](https://cloud.google.com/sdk/gcloud/reference/compute/instances/create) for more options.

##### login gcp

gcloud auth login

##### create a vm

`gcloud compute instances create hcce-vm-1 --zone=us-central1-a`

##### ssh to the vm

`gcloud compute ssh --project=hubs-dev-333333 --zone=us-central1-a geng-test-2`

##### prepare the vm

`sudo apt update && sudo apt install npm && sudo npm install pem-jwk -g`

##### install k3s without traefik -- read https://docs.k3s.io/ for more info

- `curl https://get.k3s.io/ | INSTALL_K3S_EXEC="--disable=traefik" sh -`

##### Step 2: Install k3s without traefik

- `curl https://get.k3s.io/ | INSTALL_K3S_EXEC="--disable=traefik" sh -`

- read https://docs.k3s.io/ for more info

##### Step 3: Deploy to kubernetes

- Add your services to `render_hcce.sh`
- Run `bash render_hcce.sh && sudo k3s kubectl apply -f hcce.yaml`

#### Step 3: connect the ingress
- find the vm's external ip
- create a-records to the dns
- makesure the required ports are exposed to the client

### example -- a "hello-world" instance with managed kubernetes on gcp
##### Step 1: make a kubernetes environment
replace `hcce-gke-1` and `us-central1-a` with your desired name and zone, check [official doc](https://cloud.google.com/sdk/gcloud/reference/container/clusters/create) for more options

##### login gcp

gcloud auth login

##### create gke cluster

gcloud container clusters create hcce-gke-1 --zone=us-central1-a

###### get creds for kubectl

gcloud container clusters get-credentials --region us-central1-a hcce-gke-1

- Find the vm's external IP
- Expose IP to DNS
- Configure firewall

### 10. A "potentially-somewhat-production-ready" instance on AWS

- Coming soon!

## Considerations for Production Environment

- Infrastructure
  - Easy -- use managed kubernetes
  - Hard -- make it [production-ready](https://kubernetes.io/docs/setup/production-environment/)
- Security
  - Password and Keys
  - Add a WAF
- Scalability
  - Stateful services
    - PostgreSQL
      - use a managed pgsql ie. rds on aws or cloudsql on gcp
      - roll your own
    - Reticulum
      - use a network/shared storage for reticulum's /storage mount
  - Stateless Services (all except reticulum and pgsql)
    - Run multiple replicas
    - Use HPS
- Devops
  - The two yaml files in this repo are the entire infra on kubernetes. You may want to use git to track changes and an ops pipeline to auto deploy.
    - ex. Put the yaml file on a github repo and use github action to deploy to your hosting env.
  - Use dev env for staging/testing.
    - Use spot instances for nodes to save money.
    - Develop and integrate automated testing scripts into the ops pipeline
  - Configure devops for deploying custom versions of Spoke, Hubs, and Reticulum
```
