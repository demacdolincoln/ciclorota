# samu-risco

Mapa de risco de acidentes de trânsito (chamadas do SAMU) e análise de rotas de bicicleta no Recife.
Saída: um HTML único (Leaflet + Chart.js). Dados abertos da Prefeitura do Recife e OpenStreetMap.

## Instalação (uv)
```bash
uv sync --extra dev        # cria .venv e instala dependências
uv run pytest              # 67 testes (usam um servidor CKAN simulado; não acessam a internet)
```
Sem uv: `python -m venv .venv && source .venv/bin/activate && pip install -e ".[dev]"`.

## Uso (com internet, uma vez)
```bash
uv run samu-risco coletar            # SAMU 2011-2026 -> dados/samu.duckdb (incremental)
uv run samu-risco geodados           # OSM + ciclovias, semáforos, paraciclos e bairros da Prefeitura
uv run samu-risco gerar              # -> mapa_acidentes_recife.html
# ou tudo de uma vez:
uv run samu-risco tudo
```
`uv run samu-risco relatorio` refaz o relatório do SAMU com os CSV já baixados (sem rede): mostra, por ano, colunas ausentes e subtipos de trânsito com nome diferente.

Relatórios gerados em `dados/`: `relatorio_samu.txt` (esquema e qualidade por ano),
`relatorio_geodados.txt` (colunas/valores de cada camada), `nao_casados.csv` (endereços sem via).

## O HTML gerado
- 100% offline após a geração: Leaflet, leaflet.heat e Chart.js vão embutidos (`templates/vendor/`, licenças incluídas) e os dados
  seguem comprimidos (gzip+base64, geometrias em deltas inteiros). Só os *tiles* do mapa de fundo precisam de internet;
  sem internet o app usa a **base vetorial** (bairros + malha viária) automaticamente.
- Abas **Panorama** (filtros gerais, indicadores, gráficos, ranking) e **Minha rota** (GPX, janela de horário, índice de risco,
  filtros próprios). Cada aba guarda o seu perfil de camadas.
- Painel **Camadas e estilo**: ligar/desligar, opacidade, ordem de sobreposição (▲▼), mapa de fundo (OSM, cinza claro/escuro,
  satélite, nenhum), paleta, espessura e parâmetros do calor. As preferências ficam no navegador.
- **Cores por quantil** (Panorama e Minha rota, mesma régua): cada trecho (via × bairro) é posicionado entre os trechos com registro pela contagem ponderada por gravidade e cai em 5 classes (baixo, moderado, elevado, alto, crítico; cortes P50/P75/P90/P97), recalculadas a cada filtro. Classes altas ficam mais grossas, opacas e por cima; a legenda mostra os valores de cada classe.
- Requer navegador recente (usa `DecompressionStream`).

## Fase 4: rotas
Na aba **Minha rota** (tudo no navegador, offline):
- **Risco por rota**: cada rota usa o seu horário (±1 h do GPX) e dia útil/fim de semana; editável por rota. Comparador lado a lado e perfil de risco ao longo do trajeto.
- **Planejar rota**: clique no mapa para marcar origem, destino e pontos intermediários; o roteamento (A* sobre o grafo de bicicleta do OSM embutido) combina distância, risco, preferência por ciclovia e penalidade a vias arteriais sem infraestrutura. Vias sem registro são tratadas como **incertas**, não como seguras (aviso exibido).
- **Desvio de trecho crítico**: para trechos de risco ≥ 70 sugere um desvio e mostra a variação do índice e da distância; pode ser adicionado como nova rota ou substituir a original.
- **Biblioteca de rotas** (IndexedDB do navegador): salvar rotas (ida/volta, horário habitual), importar/exportar JSON, exportar GPX individual ou em lote (**.zip** ou **.tar.gz**).
- O grafo vem de `samu-risco geodados` (baixa a malha de bicicleta do OSM na primeira vez).

### Testes do front-end (opcional, requer Node >= 20)
```bash
cd tests/js && npm install && npm test
```

## Calibração do fuzzy
```bash
uv run samu-risco calibrar-gerar     # dados/calibracao_amostra.csv (estratificada por score)
# preencha a coluna `correto` (S/N); se N, `via_correta` com a chave correta
uv run samu-risco calibrar-avaliar   # escolhe o corte (precisão >= 0,95) e grava correções
```
O corte e as correções são aplicados automaticamente nas próximas execuções de `gerar`.

## Estrutura
- `samu_risco/` ckan, samu (coleta), geodata, matching, rede (geometria), build (dados + HTML), cli
- `templates/` index.html, style.css, app.js (front-end)
- `tests/` testes automatizados

## Licenças
Dados da Prefeitura e OSM: ODbL (atribuição obrigatória).
