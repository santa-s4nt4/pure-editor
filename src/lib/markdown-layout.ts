import { parser } from '@lezer/markdown';

const literalBlocks = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'ProcessingInstruction']);
const columns = (prefix: string) => [...prefix].reduce((column, character) => character === '\t' ? column + 4 - column % 4 : column + 1, 0);

/** pure draws each unindented line outside the preceding list. CommonMark
 * instead accepts it as a lazy continuation unless a blank line separates it.
 * Preserve explicit indentation and literal blocks; add only those separators.
 */
export function normalizeMarkdownLayout(text: string): string {
  if (!text.includes('\n') || !/^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+/m.test(text)) return text;
  const literals: { from: number; to: number }[] = [];
  parser.parse(text).iterate({ enter(node) {
    if (literalBlocks.has(node.name)) { literals.push({ from: node.from, to: node.to }); return false; }
  } });
  const stack: { indent: number; content: number; ordered: string }[] = [];
  const output: string[] = [];
  let offset = 0;
  let previousBlank = true;
  let previousRaw = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const indent = columns(/^[ \t]*/.exec(line)![0]);
    const literal = literals.some(range => range.from < offset + line.length && range.to > offset);
    const naturalBlock = /^\s*(?:#{1,6}(?:[ \t]+|$)|>|(?:-[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:_[ \t]*){3,}$)/.test(line);
    const marker = !literal && !naturalBlock ? /^([ \t]*)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$/.exec(line) : null;
    if (!line.trim()) {
      previousBlank = true;
    } else if (marker) {
      const ordered = /\d/.test(marker[2][0]) ? marker[2].at(-1)! : '';
      const sibling = stack.find(item => item.indent === indent);
      // An ordered list starting above 1 cannot interrupt a paragraph, even
      // when nested. A sibling in an existing ordered list needs no separator.
      if (ordered && Number.parseInt(marker[2]) !== 1 && sibling?.ordered !== ordered && !previousBlank) output.push(previousRaw.endsWith('\r') ? '\r' : '');
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      const markerEnd = columns(marker[1] + marker[2]);
      const padding = columns(marker[1] + marker[2] + marker[3]) - markerEnd;
      stack.push({ indent, content: markerEnd + (padding > 4 ? 1 : padding), ordered });
      previousBlank = false;
    } else {
      let exited = false;
      while (stack.length && indent < stack.at(-1)!.content) { stack.pop(); exited = true; }
      if (exited && !literal && !naturalBlock && !previousBlank) output.push(previousRaw.endsWith('\r') ? '\r' : '');
      previousBlank = false;
    }
    output.push(raw); previousRaw = raw; offset += raw.length + 1;
  }
  return output.join('\n');
}
