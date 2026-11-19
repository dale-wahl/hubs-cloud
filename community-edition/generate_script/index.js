const crypto = require("crypto");
const forge = require("node-forge");
const path = require("path");
const YAML = require("yaml");
const pemJwk = require("pem-jwk");
const utils = require("../utils");

// Generate a private key and public key
function generateKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  return { publicKey, privateKey };
}

// Generate a self-signed certificate
function generateCertificate(hub_domain) {
  // Create a new certificate
  const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = publicKey;

  // Set certificate attributes
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  const attrs = [
    {
      name: "commonName",
      value: hub_domain,
    }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  // Sign the certificate with its own private key
  cert.sign(privateKey, forge.md.sha256.create());

  // Convert the certificate and private key to PEM format
  const pemCert = forge.pki.certificateToPem(cert);
  const pemPrivateKey = forge.pki.privateKeyToPem(privateKey);

  return { pemCert, pemPrivateKey };
}

// Function to convert PEM to JWK
function convertPemToJwk(publicKey) {
  const jwk = pemJwk.pem2jwk(publicKey);
  return JSON.stringify(jwk);
}

function generatePersistentVolumes(processedConfig, replacedContent) {
  const yamlDocuments = YAML.parseAllDocuments(replacedContent);
  let outputIdx = 2;
  processedConfig.PERSISTENT_VOLUME_STORAGE_CLASS ||= 'manual';

  if ('manual' === processedConfig.PERSISTENT_VOLUME_STORAGE_CLASS) {
    // Add in the persistent volume configs to the hcce.yaml file
    const persistent_volumes_template = utils.readTemplate("/generate_script", "persistent_volumes.yam");
    const replacedPersistentVolumesContent = utils.replacePlaceholders(persistent_volumes_template, processedConfig);
    YAML.parseAllDocuments(replacedPersistentVolumesContent).forEach(doc => {
      yamlDocuments.splice(outputIdx++, 0, doc);
    });
  }

  const persistent_volume_claims_template = utils.readTemplate("/generate_script", "persistent_volume_claims.yam");
  const replacedPersistentVolumeClaimsContent = utils.replacePlaceholders(persistent_volume_claims_template, processedConfig);

  // Adds in the persistent volume claims to the hcce.yaml file
  YAML.parseAllDocuments(replacedPersistentVolumeClaimsContent).forEach(doc => {
    if ('default' !== processedConfig.PERSISTENT_VOLUME_STORAGE_CLASS) {
      doc = doc.toJS();
      doc.spec.storageClassName = processedConfig.PERSISTENT_VOLUME_STORAGE_CLASS;
      if ('manual' === processedConfig.PERSISTENT_VOLUME_STORAGE_CLASS) {
        // ReadWriteOncePod is only supported for CSI volumes
        doc.spec.accessModes = ["ReadWriteOnce"];
      }
      doc = new YAML.Document(doc);
    }
    yamlDocuments.splice(outputIdx++, 0, doc);
  });

  // update the volume specifications for pgsql and reticulum to point to the persistent volumes
  yamlDocuments.forEach((doc, index) => {
    const jsDoc = doc.toJS();
    if (jsDoc.kind === "Deployment" && jsDoc.metadata.name === "pgsql") {
      jsDoc.spec.template.spec.volumes[0] = {"name": "postgresql-data", "persistentVolumeClaim": {"claimName": "pgsql-pvc"}};
      yamlDocuments[index] = new YAML.Document(jsDoc);
    }
    if (jsDoc.kind === "Deployment" && jsDoc.metadata.name === "reticulum") {
      jsDoc.spec.template.spec.volumes[0] = {"name": "storage", "persistentVolumeClaim": {"claimName": "ret-pvc"}};
      yamlDocuments[index] = new YAML.Document(jsDoc);
    }
  });

  return `${yamlDocuments.map(doc => YAML.stringify(doc, {"lineWidth": 0, "directives": false})).join('---\n')}`;
}

function handleImageOverrides(processedConfig, replacedContent) {
  const yamlDocuments = YAML.parseAllDocuments(replacedContent);

  // Override the default images with custom ones if specified in the config
  yamlDocuments.forEach((doc, index) => {
    const jsDoc = doc.toJS();
    if (jsDoc.kind === "Deployment") {
      if (jsDoc.metadata.name === "reticulum") {
        if (processedConfig.OVERRIDE_RETICULUM_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_RETICULUM_IMAGE;
          if (processedConfig.OVERRIDE_POSTGREST_IMAGE) {
            jsDoc.spec.template.spec.containers[1].image = processedConfig.OVERRIDE_POSTGREST_IMAGE;
          }
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "pgsql") {
        if (processedConfig.OVERRIDE_POSTGRES_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_POSTGRES_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "pgbouncer" || jsDoc.metadata.name === "pgbouncer-t") {
        if (processedConfig.OVERRIDE_PGBOUNCER_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_PGBOUNCER_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "hubs") {
        if (processedConfig.OVERRIDE_HUBS_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_HUBS_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "spoke") {
        if (processedConfig.OVERRIDE_SPOKE_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_SPOKE_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "nearspark") {
        if (processedConfig.OVERRIDE_NEARSPARK_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_NEARSPARK_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "photomnemonic") {
        if (processedConfig.OVERRIDE_PHOTOMNEMONIC_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_PHOTOMNEMONIC_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "dialog") {
        if (processedConfig.OVERRIDE_DIALOG_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_DIALOG_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "coturn") {
        if (processedConfig.OVERRIDE_COTURN_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_COTURN_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
      else if (jsDoc.metadata.name === "haproxy") {
        if (processedConfig.OVERRIDE_HAPROXY_IMAGE) {
          jsDoc.spec.template.spec.containers[0].image = processedConfig.OVERRIDE_HAPROXY_IMAGE;
          yamlDocuments[index] = new YAML.Document(jsDoc);
        }
      }
    }
  });

  return `${yamlDocuments.map(doc => YAML.stringify(doc, {"lineWidth": 0, "directives": false})).join('---\n')}`;
}

const SECRET_FILE_HEADER = `# Generated by \`npm run gen-hcce\`. NOT safe to apply casually.
#
# Applying this replaces every credential in the cluster, wholesale. It also
# carries a freshly minted PERMS_KEY / PGRST_JWT_SECRET keypair and a new
# self-signed certificate, because those four values are generated on every run.
#
# Apply it on a first install, or when you deliberately mean to change
# credentials -- and afterwards restart BOTH reticulum and dialog, or they will
# disagree about PERMS_KEY and voice will stop working.
`;

// 4D: this function and its two calls in main() are NOT upstream.
//
// Pull the Secret documents out of the rendered manifest.
//
// Every reference to these Secrets is a secretKeyRef, which resolves at pod start
// rather than at apply time, so the Deployments do not need the Secret to live in
// the same file. Keeping credentials out of hcce.yaml makes that file safe to
// re-apply: PERMS_KEY, PGRST_JWT_SECRET, initCert and initKey are minted fresh on
// every run, and a stale input-values.yaml would otherwise revert every credential
// in the cluster the moment someone applied it.
function splitSecrets(replacedContent) {
  const stringify = docs =>
    docs.map(doc => YAML.stringify(doc, {"lineWidth": 0, "directives": false})).join('---\n');

  const secretDocs = [];
  const manifestDocs = [];

  YAML.parseAllDocuments(replacedContent).forEach(doc => {
    const jsDoc = doc.toJS();
    (jsDoc && jsDoc.kind === "Secret" ? secretDocs : manifestDocs).push(doc);
  });

  return { manifest: stringify(manifestDocs), secrets: stringify(secretDocs) };
}

// Main function to handle the script
function main() {
  try {
    const config = utils.readConfig();
    const processedConfig = YAML.parse(
      utils.replacePlaceholders(YAML.stringify(config), config),
      {"schema": "yaml-1.1"} // required to load yes/no as boolean values
    );

    // Generate keys and certificate
    const { privateKey, publicKey } = generateKeys();
    const { pemCert, pemPrivateKey } = generateCertificate(config.HUB_DOMAIN);

    processedConfig.PGRST_JWT_SECRET = convertPemToJwk(publicKey);
    processedConfig.PERMS_KEY = privateKey.replace(/\n/g, "\\\\n");
    processedConfig.initCert = Buffer.from(pemCert).toString('base64').replace(/\n/g, "");
    processedConfig.initKey = Buffer.from(pemPrivateKey).toString('base64').replace(/\n/g, "");

    // generate the hcce.yaml file
    const template = utils.readTemplate("/generate_script", "hcce.yam");
    var replacedContent = utils.replacePlaceholders(template, processedConfig);

    if (processedConfig.GENERATE_PERSISTENT_VOLUMES) {
      replacedContent = generatePersistentVolumes(processedConfig, replacedContent);
    }

    replacedContent = handleImageOverrides(processedConfig, replacedContent)

    const split = splitSecrets(replacedContent);
    utils.writeOutputFile(split.manifest, "", "hcce.yaml");
    utils.writeOutputFile(SECRET_FILE_HEADER + split.secrets, "", "hcce-secret.yaml");

  } catch (error) {
    console.error("Error in main function:", error);
  }
}

main();
