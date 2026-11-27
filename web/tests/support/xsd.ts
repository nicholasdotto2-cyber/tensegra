import { readFileSync } from "node:fs";
import { validateXML } from "xmllint-wasm";

const schemaName = "Schema_VFPR12_v1.2.3.xsd";
const signatureName = "xmldsig-core-schema.xsd";
const schema = readFileSync(new URL(`../fixtures/fatturapa/${schemaName}`, import.meta.url), "utf8");
const signature = readFileSync(new URL(`../fixtures/fatturapa/${signatureName}`, import.meta.url), "utf8");

/** Valida sullo schema ufficiale, compreso l'import della firma, senza rete. */
export async function validateFatturaXml(xml: string): Promise<{ valid: boolean; errors: string[] }> {
  const result = await validateXML({
    xml: [{ fileName: "fattura.xml", contents: xml }],
    schema: [{ fileName: schemaName, contents: schema }],
    preload: [{ fileName: signatureName, contents: signature }],
  });

  return { valid: result.valid, errors: result.errors.map((error) => error.rawMessage) };
}
