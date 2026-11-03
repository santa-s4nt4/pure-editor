import { videoEmbed } from './transformer';

export function mediaLine(text: string): { prefix: string; image?: { path: string; alt: string }; video?: { src: string; title: string } } | null {
  const list = /^(\s*(?:[-+*]|\d+[.)])\s+)(.*)$/.exec(text);
  const prefix = list?.[1] ?? '';
  const source = (list?.[2] ?? text).trim();
  const image = /^!\[([^\]\n]*)\]\((assets\/[^\n]+\.webp)\)$/.exec(source);
  if (image) return { prefix, image: { path: image[2], alt: image[1] } };
  const markdown = /^\[[^\]]*\]\((https?:\/\/[^\s]+)\)$/.exec(source);
  const simple = /^\[(https?:\/\/[^\s\]]+)\]$/.exec(source);
  const video = videoEmbed(markdown?.[1] ?? simple?.[1] ?? source);
  return video ? { prefix, video } : null;
}
