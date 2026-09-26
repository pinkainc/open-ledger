// The twelve schemas every ledger is created with (recorded from the reference,
// `docs/reference-system-schemas.json`), in the order the reference lists them.
// They name what records of a kind may look like: a bridge must choose one of the
// bridge schemas (`rest`), a policy one of the policy schemas, and so on.
export const SYSTEM_SCHEMAS: readonly object[] = [
  {
    "handle": "status",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for status policies"
    }
  },
  {
    "handle": "layout",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for layout policies"
    }
  },
  {
    "handle": "access",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for access policies"
    }
  },
  {
    "handle": "labels",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for labels policies"
    }
  },
  {
    "handle": "schedule",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object",
      "required": [
        "record",
        "action",
        "inputs"
      ],
      "properties": {
        "handle": {
          "title": "Handle",
          "type": "string"
        },
        "custom": {
          "title": "",
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "legend": {
              "title": "Legend",
              "type": "string",
              "description": "Description for this schedule policy"
            }
          }
        },
        "record": {
          "title": "Record",
          "type": "string",
          "enum": [
            "report"
          ],
          "description": "Record this schedule policy applies to"
        },
        "action": {
          "title": "Action",
          "type": "string",
          "enum": [
            "create"
          ],
          "description": "Action to perform"
        },
        "config": {
          "title": "",
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "timezone": {
              "title": "Timezone",
              "type": "string",
              "format": "timezone",
              "description": "Timezone to use for the schedule"
            }
          }
        },
        "inputs": {
          "title": "Inputs",
          "description": "Inputs used for the final record creation",
          "type": "object",
          "additionalProperties": false,
          "required": [
            "schema"
          ],
          "properties": {
            "schema": {
              "title": "Schema",
              "type": "string",
              "description": "Schema to use for the record"
            },
            "custom": {
              "title": "",
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "timezone": {
                  "title": "Timezone",
                  "type": "string",
                  "description": "Timezone used for the report."
                },
                "closes": {
                  "title": "Closes",
                  "type": "string",
                  "description": "Close time for the report."
                }
              }
            }
          }
        }
      }
    },
    "custom": {
      "description": "Schema created by ledger for schedule policies"
    }
  },
  {
    "handle": "processing",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for processing policies"
    }
  },
  {
    "handle": "authentication",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for authentication policies"
    }
  },
  {
    "handle": "dtc",
    "format": "json-schema",
    "record": "policy",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for DTC participant policies"
    }
  },
  {
    "handle": "rest",
    "format": "json-schema",
    "record": "bridge",
    "schema": {
      "type": "object",
      "properties": {
        "config": {
          "type": "object",
          "properties": {
            "server": {
              "type": "string"
            }
          },
          "required": [
            "server"
          ]
        },
        "custom": {
          "title": "",
          "type": "object"
        },
        "secure": {
          "type": "array",
          "items": {
            "title": "Security rule"
          }
        }
      },
      "required": [
        "config"
      ]
    },
    "custom": {
      "description": "Schema created by ledger for rest bridge"
    }
  },
  {
    "handle": "oauth-client-credentials",
    "format": "json-schema",
    "record": "signer-factor",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for signer factors of type OAuth2 client credentials"
    }
  },
  {
    "handle": "key-pair",
    "format": "json-schema",
    "record": "signer-factor",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for key-pair signer factors"
    }
  },
  {
    "handle": "otp",
    "format": "json-schema",
    "record": "signer-factor",
    "schema": {
      "type": "object"
    },
    "custom": {
      "description": "Schema created by ledger for OTP signer factors"
    }
  }
]
