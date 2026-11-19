# Algoritmos experimentais

Todo `*.js` desta pasta é concatenado depois de `rotas.js` pelo build (`samu_risco/build.py::_experimental`), no mesmo
escopo, e pode usar o grafo e os helpers de `rotas.js`. Nada aqui é chamado pelo fluxo normal de roteamento: cada módulo
se liga à interface por um botão próprio e expõe suas funções em `window.__rotas` para teste.

| módulo | o que faz | botão |
|---|---|---|
| `mapmatch.js` | map matching (HMM/Viterbi) de um traçado nas arestas do grafo e comparação de duas rotas aresta por aresta | 🧭 Casar traçado com o grafo |

Para remover um experimento basta apagar o arquivo (e o botão correspondente em `index.html`).
