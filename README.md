# Painel de Mídia — Ituran Mob

Relatório interativo dos anúncios do Meta. Dois arquivos:

| arquivo | o que faz |
|---|---|
| `painel-ads.html` | o painel. Abre no navegador, lê o arquivo de dados localmente. Nada é enviado para servidor nenhum. |
| `puxar-meta.mjs` | baixa os resultados direto da Marketing API do Meta e grava `dados-meta.json`. |

O painel também aceita o CSV do Gerenciador de Anúncios, se você não quiser mexer com token.
A diferença está no fim deste arquivo.

---

## Puxando direto da API

### 1. Um token de acesso com `ads_read`

**Rápido (token curto, ~1 a 2 horas — bom para uma puxada avulsa):**

1. Abra <https://developers.facebook.com/tools/explorer/>
2. Em *Meta App*, escolha um app seu (qualquer um serve; se não tiver, crie um do tipo "Nenhum/Outro")
3. Em *Permissions*, adicione `ads_read`
4. Clique em **Generate Access Token** e autorize
5. Copie o token

**Duradouro (não expira — bom para rodar todo mês):**

1. Business Manager → **Configurações do negócio**
2. **Usuários → Usuários do sistema** → *Adicionar*
3. No usuário criado: **Adicionar ativos** → *Contas de anúncios* → escolha a conta → permissão de **visualização**
4. **Gerar novo token** → escolha o app → marque `ads_read` → gerar
5. Copie e guarde — o Meta mostra o token uma vez só

### 2. Testar a conexão

Precisa de Node 18 ou mais novo (`node --version`). Não instala nada.

**macOS / Linux:**

```bash
export META_ACCESS_TOKEN="EAAG..."
node puxar-meta.mjs --contas
```

**Windows — Prompt de Comando (cmd):** é `set`, sem aspas e sem espaço antes do `=`.

```bat
set META_ACCESS_TOKEN=EAAG...
node puxar-meta.mjs --contas
```

**Windows — PowerShell:**

```powershell
$env:META_ACCESS_TOKEN = "EAAG..."
node puxar-meta.mjs --contas
```

**Funciona igual em todos:** crie um arquivo chamado `.env` na pasta do projeto
(sem nome antes do ponto) e escreva as duas linhas abaixo. O script lê sozinho, e
o `.env` já está no `.gitignore`.

```
META_ACCESS_TOKEN=EAAG...
META_AD_ACCOUNT_ID=act_1234567890
```

Com o `.env` pronto, é só `node puxar-meta.mjs --contas` — sem `set` nem `export`.

Ele diz se o token vale, com qual usuário você está autenticado, e lista todas as
contas de anúncios que esse token enxerga — já com o `act_...` pronto para copiar:

```
✓ Token válido — autenticado como Fulano (Graph v23.0)

Contas visíveis para este token (2):

  Ituran Mob      act_1234567890       BRL  ativa
  Teste antigo    act_9876543210       BRL  desativada

  Para puxar a conta "Ituran Mob":

    export META_AD_ACCOUNT_ID="act_1234567890"
    node puxar-meta.mjs --desde 2026-08-01
```

Se preferir pegar o id à mão, é o número depois de `act_` na URL do Gerenciador:
`business.facebook.com/adsmanager/manage/campaigns?act=**1234567890**`

### 3. Puxar

Com o `.env` preenchido, basta:

```bash
node puxar-meta.mjs --desde 2026-08-01
```

Sem `.env`, defina também o id da conta antes (`set` no cmd, `$env:` no PowerShell,
`export` no macOS/Linux) — ou passe direto na linha de comando:

```bash
node puxar-meta.mjs --conta act_1234567890 --desde 2026-08-01
```

Ou crie um arquivo `.env` na mesma pasta (já está no `.gitignore`):

```
META_ACCESS_TOKEN=EAAG...
META_AD_ACCOUNT_ID=act_1234567890
```

Opções:

```
--desde  AAAA-MM-DD   início do período   (padrão: dia 1 do mês corrente)
--ate    AAAA-MM-DD   fim do período      (padrão: hoje)
--conta  act_123      id da conta         (ou META_AD_ACCOUNT_ID)
--saida  arquivo.json onde gravar         (padrão: dados-meta.json)
--nivel  ad|adset|campaign                (padrão: ad)
--nivel-cortes  ad|adset|campaign         nível dos recortes (padrão: campaign)
--sem-thumbs          não baixa as miniaturas dos criativos
--api    v23.0        versão da Graph API
--contas              testa o token e lista as contas que ele enxerga
```

### 4. Abrir o painel

Abra `painel-ads.html` no navegador e solte o `dados-meta.json` nele.
Ou use o painel publicado e solte o arquivo lá — ele lê tudo no seu navegador.

---

## O que o script traz

Uma consulta por recorte, todas no período pedido:

| recorte | nível | conteúdo |
|---|---|---|
| `diario` | anúncio, por dia | gasto, impressões, alcance, cliques, todas as ações, funil de vídeo |
| `posicionamento` | campanha, por dia | plataforma × posicionamento × dispositivo |
| `criativo_posicionamento` | anúncio, agregado | qual criativo vai melhor em cada posicionamento |
| `demografia` | campanha, por dia | idade × gênero |
| `regiao` | campanha, agregado | estado / região |
| `hora` | campanha, agregado | hora do dia no fuso da conta |

Mais o catálogo de **tipos de ação** que a conta gerou (lead, cadastro pelo pixel,
formulário instantâneo, conversa iniciada, clique no link…) — no painel dá para
escolher qual deles conta como "lead" e tudo recalcula — e os **criativos** com
miniatura embutida, título e texto.

### Um aviso importante sobre os recortes

Cada recorte é uma pergunta diferente feita à API. Cada um **fecha dentro de si**,
mas somar dois deles conta a mesma pessoa duas vezes, e nenhum bate casa decimal
com o total da conta — o Meta deduplica por pessoa dentro de cada divisão.
Compare fatias dentro do mesmo recorte, nunca entre recortes.

O mesmo vale para **alcance**: somar linhas infla o número, porque a mesma pessoa
aparece em dias e posicionamentos diferentes. O painel marca esses casos com `≈`.

---

## Segurança

- O token fica só na sua máquina, em variável de ambiente ou `.env` (ignorado pelo git).
- O script não grava o token no `dados-meta.json` nem o imprime na tela.
- `dados-meta.json` tem os números reais da conta e **também está no `.gitignore`** —
  não faça commit dele.
- O painel roda inteiramente no navegador: o arquivo nunca sobe para lugar nenhum.

## Erros comuns

| mensagem | o que fazer |
|---|---|
| `O token não foi aceito` / `code 190` | token expirado ou revogado; gere outro. Para não repetir isso, use um usuário do sistema |
| `não consegue listar contas de anúncios` | falta `ads_read`; gere o token de novo com essa permissão marcada |
| `não enxerga nenhuma conta` | o usuário não tem acesso à conta. Se for usuário do sistema, atribua a conta a ele em *Adicionar ativos* |
| `code 100` id inválido | confira o número depois de `act_` na URL do Gerenciador |
| `limite de chamadas do Meta` | o script já espera e tenta de novo sozinho; períodos longos demoram mais |
| `(#3018) breakdown` num recorte | aquele recorte não existe para essa conta/objetivo — o painel esconde a seção e segue |
| não consegui falar com graph.facebook.com | rede, proxy ou VPN bloqueando |
| `'export' não é reconhecido...` | você está no Windows: use `set` no cmd, `$env:` no PowerShell, ou o arquivo `.env` |
| `'node' não é reconhecido...` | Node não instalado ou fora do PATH — instale em nodejs.org e **abra um terminal novo** |

---

## Alternativa sem token: CSV

No Gerenciador de Anúncios: período desejado → colunas **"Desempenho e cliques"** →
**Divisão: Por dia** (e, para o mapa de posicionamentos, também *Plataforma* e
*Posicionamento*) → **Relatórios → Exportar → `.csv`**. Solte o arquivo no painel.

O painel entende export em português ou inglês, separado por vírgula, ponto e vírgula
ou tabulação, com números `1.234,56` ou `1,234.56`, e tem um painel de **Colunas**
para corrigir qualquer mapeamento que ele erre.

O CSV não carrega: idade × gênero cruzados, região, hora do dia, retenção de vídeo,
todos os tipos de conversão, nem as miniaturas dos criativos. Para isso, é a API.
