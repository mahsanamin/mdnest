// MDAST uses null when an image has no optional Markdown title. Milkdown's
// image schemas require a string, including for a block image's caption.
// Normalize at the parser boundary; retain validation for malformed values.
export function withDefaultImageTitle(createSchema) {
  return (ctx) => {
    const spec = createSchema(ctx);
    return {
      ...spec,
      parseMarkdown: {
        ...spec.parseMarkdown,
        runner(state, node, type) {
          return spec.parseMarkdown.runner(state, {
            ...node,
            title: node.title ?? '',
          }, type);
        },
      },
    };
  };
}
