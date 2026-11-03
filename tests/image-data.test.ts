import { expect, it } from 'vitest';
import { dataImageBlob } from '../src/lib/image-data';
it('HTML クリップボードの data URL をネットワーク通信なしで画像バイナリへ戻す', async () => {
  const blob = dataImageBlob('data:image/png;base64,iVBORw0KGgo=');
  expect(blob.type).toBe('image/png');
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  expect(() => dataImageBlob('https://example.com/image.png')).toThrow();
});
