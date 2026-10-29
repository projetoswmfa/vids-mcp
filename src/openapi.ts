export function getOpenApiSpec(origin: string = "https://vids-mcp.welldevs.com.br") {
  return {
    openapi: "3.1.0",
    info: {
      title: "Google Vids MCP API",
      description: "API de geração, consulta e automação do Google Vids para ChatGPT e Claude.",
      version: "0.1.0"
    },
    servers: [
      {
        url: origin
      }
    ],
    paths: {
      "/api/health": {
        get: {
          summary: "Verifica se o servidor MCP está ativo",
          operationId: "healthCheck",
          responses: {
            "200": {
              description: "Servidor online",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      status: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      },
      "/api/status": {
        post: {
          summary: "Verifica a sessão do Google Vids, fila de jobs e projetos",
          operationId: "vidsStatus",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {}
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Status da sessão e fila",
              content: {
                "application/json": {
                  schema: {
                    type: "object"
                  }
                }
              }
            }
          }
        }
      },
      "/api/generate": {
        summary: "Enfileira a geração de clipes de vídeo ou imagens no Google Vids",
        operationId: "vidsGenerate",
        post: {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["project", "scenes"],
                  properties: {
                    project: { type: "string", description: "Nome do projeto / vídeo" },
                    aspect: { type: "string", enum: ["16:9", "9:16"], default: "16:9" },
                    scenes: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["prompt"],
                        properties: {
                          prompt: { type: "string", description: "Descrição visual da cena para o Omni" },
                          duration_seconds: { type: "number", minimum: 3, maximum: 10, default: 6 },
                          type: { type: "string", enum: ["video", "still"], default: "video" }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "IDs dos jobs criados",
              content: {
                "application/json": {
                  schema: {
                    type: "object"
                  }
                }
              }
            }
          }
        }
      },
      "/api/wait": {
        post: {
          summary: "Aguarda a conclusão dos jobs de vídeo",
          operationId: "vidsWait",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    job_ids: {
                      type: "array",
                      items: { type: "string" }
                    },
                    timeout_seconds: { type: "number", default: 60 }
                  }
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Resultado dos jobs concluídos",
              content: {
                "application/json": {
                  schema: {
                    type: "object"
                  }
                }
              }
            }
          }
        }
      },
      "/api/outputs": {
        post: {
          summary: "Lista todos os vídeos e arquivos exportados",
          operationId: "vidsOutputs",
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object"
                }
              }
            }
          },
          responses: {
            "200": {
              description: "Lista de arquivos gerados",
              content: {
                "application/json": {
                  schema: {
                    type: "object"
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}
