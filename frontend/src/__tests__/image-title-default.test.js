// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Ctx, Container, Clock } from '@milkdown/ctx';
import { Schema } from '@milkdown/prose/model';
import { imageSchema } from '@milkdown/preset-commonmark';
import { imageBlockSchema } from '@milkdown/components/image-block';
import { withDefaultImageTitle } from '../image-title-default.js';

for (const [definition, attribute] of [[imageSchema, 'title'], [imageBlockSchema, 'caption']]) {
  describe(`real Milkdown ${definition.id} parser`, () => {
    function parse(title, patched) {
      const ctx = new Ctx(new Container(), new Clock());
      definition.ctx(ctx);
      let factory = ctx.get(definition.key);
      if (patched) factory = withDefaultImageTitle(factory);
      const spec = factory(ctx);
      const schema = new Schema({ nodes: {
        doc: { content: `${definition.id}*` },
        text: {},
        [definition.id]: spec,
      } });
      let result;
      spec.parseMarkdown.runner({
        addNode(type, attrs) { result = type.createAndFill(attrs); },
      }, { type: definition.id, url: '/fixture.svg', alt: 'sample', title }, schema.nodes[definition.id]);
      return result;
    }

    it('reproduces the original rejection of a valid untitled image', () => {
      expect(() => parse(null, false)).toThrow(/Expected value of type string/);
    });
    it.each([null, undefined, ''])('accepts an absent title (%s) without changing the URL', title => {
      const node = parse(title, true);
      expect(node.attrs[attribute]).toBe('');
      expect(node.attrs.src).toBe('/fixture.svg');
    });
    it('preserves a supplied title', () => {
      expect(parse('My image', true).attrs[attribute]).toBe('My image');
    });
    it('continues rejecting malformed non-string titles', () => {
      expect(() => parse(123, true)).toThrow(/Expected value of type string/);
    });
  });
}
