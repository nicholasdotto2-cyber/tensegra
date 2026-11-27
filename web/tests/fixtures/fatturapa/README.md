# Fixture FatturaPA

Schema ufficiale della fattura ordinaria FPR12 1.2.3, namespace
`http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2`.
I file originali sono stati scaricati dalle fonti ufficiali elencate qui sotto.
Gli hash SHA-256 originali sono stati verificati prima della copia, senza rete.

## Fonti e hash originali

- `Schema_VFPR12_v1.2.3.xsd` (originale locale: `vfpr12.xsd`):
  <https://www.agenziaentrate.gov.it/portale/documents/d/guest/schema_vfpr12_v1-2-3>
  e <https://www.fatturapa.gov.it/export/documenti/fatturapa/v1.4/Schema_VFPR12_v1.2.3.xsd>.
  SHA-256 originale: `152944f6eef9f5d69ef6e955ee173b32142b00a8c1c5222fc97dfab5910e8a8c`.
- `xmldsig-core-schema.xsd`, importato dallo schema FPR12:
  <http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd>.
  SHA-256 originale: `35cf8197da812c85e40d57891b35c94187569ed474a2dac813ce5090dafcd35c`.

## Unica modifica allo schema FPR12

Nella riga dell'import della firma, solo
`schemaLocation="http://www.w3.org/TR/2002/REC-xmldsig-core-20020212/xmldsig-core-schema.xsd"`
diventa `schemaLocation="xmldsig-core-schema.xsd"`.
Ogni altro byte, compreso il BOM originale, resta invariato.
Lo schema xmldsig è una copia identica all'originale.

SHA-256 della copia modificata `Schema_VFPR12_v1.2.3.xsd`:
`e8fd1160860ed4ca5acebc773c624892771ebaf3ed604faa1a4c7631874fc00f`.
La copia conserva le terminazioni di riga CRLF e il BOM originali; la regola
`* -text` in `.gitattributes` mantiene i byte invariati al checkout.

Con lo schema della firma passato come `preload` a `xmllint-wasm`,
i test girano offline.

## Esempio F2

`F2.xml` è un esempio completo di fattura FPR12 per il caso F2 dei test.
I dati sono inventati e destinati esclusivamente alla demo locale.
