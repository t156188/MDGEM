// Syntax highlighting should kick in for .js (highlight.js).
export function greet(name = "world") {
  const parts = [`hello, ${name}!`];
  for (let i = 0; i < 3; i++) parts.push(`line ${i}`);
  return parts.join("\n");
}





const data = { a: 1, b: [2, 3], c: { deep: true } };
console.log(greet("MDGEM"), JSON.stringify(data));
