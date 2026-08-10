export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "synara_desktop",
      title: "Synara Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}
