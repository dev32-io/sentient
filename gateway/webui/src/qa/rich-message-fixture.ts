/** Public synthetic R0 example. Explicit expected exports, not parser output. */
export const R0_MARKDOWN = String.raw`Before café 👩🏽‍💻 — select from here into any cell.

| Name | Observation | Value |
| --- | --- | --- |
| Alpha café | partial 👩🏽‍💻 text é | 42 \| units |
| Beta 東京 | Readable wide column with retained horizontal position | 7\\8 |

After table — selection continues here. Stream: `;

export const R0_PLAIN =
  "Before café 👩🏽‍💻 — select from here into any cell.\nName\tObservation\tValue\nAlpha café\tpartial 👩🏽‍💻 text é\t42 | units\nBeta 東京\tReadable wide column with retained horizontal position\t7\\8\nAfter table — selection continues here. Stream: ";

export const R0_TABLE_MARKDOWN = String.raw`| Name | Observation | Value |
| --- | --- | --- |
| Alpha café | partial 👩🏽‍💻 text é | 42 \| units |
| Beta 東京 | Readable wide column with retained horizontal position | 7\\8 |`;
