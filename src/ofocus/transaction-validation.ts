import { XMLParser, XMLValidator } from "fast-xml-parser";

const NAMESPACE = "http://www.omnigroup.com/namespace/OmniFocus/v2";

/** Validate structure before packaging, encryption or any transaction upload.
 * This is not an OmniFocus field-level schema validator.
 */
export function validateTransactionXml(xml: string): void {
  const reject = (reason: string): never => {
    throw new Error(`Invalid OmniFocus transaction; not uploaded: ${reason}`);
  };
  if (!xml.trim()) reject("empty XML");
  // XML 1.0 forbids these controls, including inside notes and CDATA.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(xml))
    reject("illegal XML character");
  // Ignore literal markup inside comments/CDATA for declaration checks.
  const markup = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, m => " ".repeat(m.length));
  if (/<!DOCTYPE\b|<!ENTITY\b/i.test(markup)) reject("DTD and entity declarations are not supported");
  const declarations = [...markup.matchAll(/<\?xml(?=\s|\?>)/g)];
  if (declarations.length > 1 || (declarations.length === 1 && declarations[0].index !== 0))
    reject("XML declaration must occur only at the start");
  const validation = XMLValidator.validate(xml);
  if (validation !== true) reject(`malformed XML at line ${validation.err.line}, column ${validation.err.col}`);
  const nodes = new XMLParser({ preserveOrder: true, ignoreAttributes: false, processEntities: false }).parse(xml);
  const elements = (items: any[]): any[] => items.filter(n => Object.keys(n).some(k => k !== ":@" && !k.startsWith("?") && !k.startsWith("#")));
  const roots = elements(nodes);
  if (roots.length !== 1 || !Object.hasOwn(roots[0], "omnifocus")) reject("expected one OmniFocus root");
  if (roots[0][":@"]?.["@_xmlns"] !== NAMESPACE) reject("incorrect OmniFocus namespace");
  const pending = [...roots[0].omnifocus];
  while (pending.length) {
    const node = pending.pop();
    for (const [name, children] of Object.entries(node)) {
      if (name === "omnifocus" || name.endsWith(":omnifocus")) reject("nested OmniFocus document");
      if (Array.isArray(children)) pending.push(...children);
    }
  }
}
