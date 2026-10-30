import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { OmniFocusStore } from '../src/ofocus/store.js';
import { buildUpdateProjectReview, buildBatchProjectReview } from '../src/ofocus/writer.js';

const ns = 'http://www.omnigroup.com/namespace/OmniFocus/v2';
const wrap = (body: string) => `<omnifocus xmlns="${ns}">${body}</omnifocus>`;
const update = buildUpdateProjectReview('project-test', 'folder-test', 'active', {});
const invalid = [
  '',
  ' <?xml version="1.0"?>' + wrap(''),
  wrap(update), // Actual failure: a complete builder document nested in a batch.
  wrap(wrap('<task/>')),
  wrap('') + '<other/>',
  '<other>' + wrap('') + '</other>',
  '<omnifocus xmlns="wrong"/>',
  `<omnifocus xmlns="${ns}"><task></omnifocus>`,
  wrap('<task><name>bad\u0000text</name></task>'),
  '<!DOCTYPE omnifocus [<!ENTITY x "value">]>' + wrap(''),
];
for (const [index, xml] of invalid.entries()) {
  test(`invalid transaction ${index} never reaches upload`, async () => {
    let puts = 0;
    const store = new OmniFocusStore({ put: async () => { puts++; } } as any, 'https://example.invalid/');
    await assert.rejects(store.writeTransaction(xml, []), /not uploaded/);
    assert.equal(puts, 0);
  });
}
for (const [index, xml] of [
  update,
  buildBatchProjectReview([{ id: 'one', folderId: null, status: 'active', fields: {} }, { id: 'two', folderId: null, status: 'active', fields: {} }]),
  wrap('<task><note><![CDATA[<?xml version="1.0"?><omnifocus>literal</omnifocus>]]></note></task>'),
].entries()) {
  test(`valid transaction ${index} uploads unchanged XML once`, async () => {
    const uploads: Uint8Array[] = [];
    const store = new OmniFocusStore({ put: async (_url: string, bytes: Uint8Array) => { uploads.push(bytes); } } as any, 'https://example.invalid/');
    await store.writeTransaction(xml, []);
    assert.equal(uploads.length, 1);
    assert.equal(strFromU8(unzipSync(uploads[0])['contents.xml']), xml);
  });
}
