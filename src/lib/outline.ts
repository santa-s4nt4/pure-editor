import { parser } from '@lezer/markdown';

export interface OutlineHeading { from: number; level: number; title: string }

/** パーサーを使い、コード中の # を目次に混ぜない。位置はエディターの文字位置。 */
export function articleOutline(text: string): OutlineHeading[] {
  const headings: OutlineHeading[] = [];
  parser.parse(text).iterate({ enter(node) {
    const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(node.name);
    if (!heading) return;
    const source = text.slice(node.from, node.to).split('\n')[0];
    const title = source.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '').replace(/[ \t]+#+[ \t]*$/, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[https?:\/\/\S+[ \t]+([^\]]+)\]/g, '$1')
      .replace(/\[([^\]]+)\]/g, '$1').replace(/[*_`~]/g, '').trim();
    if (title) headings.push({ from: node.from, level: Number(heading[1]), title });
    return false;
  } });
  return headings;
}
