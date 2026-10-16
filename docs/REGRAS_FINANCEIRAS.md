# Regras financeiras

Este documento descreve como o Finance AI registra e calcula o dinheiro da família. Todas as regras
ficam em serviços do servidor (`src/server/modules/**`). Nenhuma tela ou agente de IA altera dados
financeiros sem passar por eles.

## 1. Valores, datas e fuso

- Os valores são guardados como **inteiros em centavos**. O sistema não usa ponto flutuante para dinheiro.
  Cada lançamento vai até R$ 10.000.000,00.
- As datas de calendário (compra, competência, vencimento) usam `AAAA-MM-DD`. "Hoje" é sempre
  calculado no fuso da família (padrão `America/Recife`).
- Moeda: BRL, formatada em pt-BR (`R$ 1.234,56`).

## 2. Transação, movimento de caixa e parcela

| Conceito | Tabela | O que representa |
|---|---|---|
| **Transação** | `Transaction` | O evento econômico: "comprei R$ 300 no mercado em 3x". |
| **Movimento de caixa** | `LedgerEntry` | Dinheiro que entrou ou saiu de uma conta. É derivado da transação. |
| **Parcela** | `Installment` | Parte da compra no cartão lançada numa fatura. É derivada da transação. |

Os **saldos das contas são sempre calculados a partir dos movimentos de caixa**. Saldo nunca é editado
diretamente. Os movimentos e as parcelas são regenerados de forma idempotente (`repostTransaction`) a
cada criação, edição, exclusão ou restauração. Assim, refazer o cálculo nunca duplica nada.

### Tipos de transação

| Tipo | Efeito no caixa | Conta como despesa/receita? |
|---|---|---|
| `EXPENSE` em conta (PIX, débito, dinheiro, boleto…) | saída na conta | despesa |
| `EXPENSE` no cartão de crédito | **nenhum**: gera parcelas nas faturas | despesa |
| `INCOME` | entrada na conta | receita |
| `TRANSFER` | saída na origem + entrada no destino, mesmo valor | **não** (soma zero) |
| `CARD_PAYMENT` (pagamento de fatura) | saída na conta pagadora | **não**: a despesa já foi reconhecida na compra |
| `ADJUSTMENT` (ajuste de saldo) | entrada ou saída na conta | não |

Por isso, **pagar a fatura não duplica as despesas**. As compras do cartão viram despesa uma única vez,
na compra. O pagamento só tira o dinheiro da conta.

Transações **pendentes** (aguardando confirmação) e **excluídas** não geram movimentos nem parcelas e
não entram em totais, gráficos ou orçamentos.

## 3. Cartão de crédito, faturas e parcelamentos

- **Fechamento**: acontece no "dia de fechamento" de cada mês. Em meses mais curtos, vale o último dia.
- Compras feitas **antes** do dia de fechamento entram na fatura que fecha naquele mês. Compras feitas
  **no dia de fechamento ou depois** entram na fatura seguinte.
- **Vencimento**: se o dia de vencimento for maior que o de fechamento, a fatura vence no mesmo mês do
  fechamento. Se não, vence no mês seguinte.
- **Mês de referência** da fatura = mês do vencimento ("fatura de novembro").
- **Parcelamento em N vezes**: a parcela *k* cai na *k*-ésima fatura a partir da fatura da compra. O
  resto da divisão em centavos fica na 1ª parcela (ex.: R$ 100,00 em 3x = 33,34 + 33,33 + 33,33).
- **Faturas futuras** são criadas sob demanda (`ensureStatement`). Assim, o total de cada fatura e os
  compromissos futuros (`/api/v1/cards/commitments`) aparecem antes do fechamento.
- **Pagamento de fatura** (`payStatement`) cria uma transação `CARD_PAYMENT` ligada à fatura. O
  pagamento parcial é permitido. Depois do vencimento, a fatura com pagamento parcial aparece como
  "parcial"; sem pagamento, como "vencida".
- Status da fatura: futura → aberta (ciclo atual) → fechada → paga / parcial / vencida.
- **Limite disponível** = limite − parcelas em aberto de todas as faturas não pagas.

## 4. Regime de competência × caixa

A família escolhe o regime padrão em Configurações. Todos os relatórios aceitam os dois.

- **Competência (`ACCRUAL`)**: a despesa conta na data de competência da compra (padrão = data da
  compra), pelo valor total, mesmo parcelada.
- **Caixa (`CASH`)**: o que não é cartão conta na data do lançamento. Compras no cartão contam
  parcela a parcela, na data de vencimento da fatura de cada parcela.

## 5. Transferências e metas

- A transferência exige origem e destino diferentes. Ela não altera o patrimônio total da família e
  não aparece como despesa nem como receita.
- **Contribuição para meta**:
  - sem conta informada: é uma **alocação interna** (só o progresso da meta muda);
  - com conta de origem diferente da conta vinculada à meta: vira uma **transferência** entre contas;
  - com valor negativo: é um resgate.

  Nenhum desses casos conta como despesa.

## 6. Duplicidade

1. **Mesma mensagem entregue duas vezes** (o WhatsApp reenviou, o webhook repetiu): bloqueada no banco
   pelas chaves únicas `(conexão, id externo da mensagem)` e `(mensagem de origem, índice do item)`.
2. **Mesmo comprovante enviado de novo**: identificado pelo hash SHA-256 da imagem (único por família).
3. **Lançamentos parecidos vindos de mensagens diferentes**: mesmo tipo e valor, data dentro da janela
   da família (padrão 48 h) e descrição/estabelecimento semelhantes. O sistema **não descarta**
   nada sozinho. Com pontuação ≥ 0,75, o novo lançamento fica **pendente de confirmação** e a
   suspeita aparece em Pendências.

## 7. Exclusão, restauração e histórico

- Excluir uma transação é **exclusão lógica** (`deletedAt`): ela some dos saldos e relatórios e pode
  ser restaurada.
- A exclusão definitiva exige permissão e a confirmação digitada "EXCLUIR".
- O sistema recusa exclusões em massa pedidas por mensagem ("apaga tudo").
- Toda criação, edição, exclusão, restauração e confirmação gera um registro de auditoria com
  quem fez, quando, de onde (painel, WhatsApp, importação, sistema) e os valores antes/depois.
- Edições usam **versão** (`expectedVersion`): duas pessoas editando ao mesmo tempo não se sobrescrevem
  sem aviso.

## 8. Orçamentos

- O limite é mensal por categoria. O realizado considera as despesas confirmadas do mês, no regime
  padrão da família.
- Alertas são emitidos ao atingir 50%, 75%, 90% e 100% do limite (configurável), **uma vez por limiar
  e por mês** (`BudgetAlert`).
- A projeção até o fim do mês é uma **estimativa linear** (gasto até hoje ÷ dias decorridos × dias do
  mês) e aparece com o rótulo "estimativa".

## 9. Recorrências e contas a pagar

- A recorrência é uma regra (mensal, semanal, anual… com intervalo e dia do mês). Ela gera
  **ocorrências previstas** (`ScheduledPayment`) para os próximos 60 dias.
- Com "lançamento automático", a ocorrência vira transação na data de vencimento. Sem ele, a
  ocorrência fica "a pagar" até alguém pagá-la ou ignorá-la.
- Pagar uma conta cria a transação e liga a ocorrência a ela. Desfazer o pagamento exclui
  (logicamente) a transação. Uma conta paga nunca gera um segundo lançamento.
- Mensagens como "paguei a conta de luz" são associadas à ocorrência prevista correspondente
  (`findMatchingScheduledPayment`) em vez de criar uma despesa nova.
- Valor variável (energia, água): o valor da regra é uma estimativa. Vale o valor pago.

## 10. Conciliação de extratos importados

Na importação de CSV, OFX, XLSX ou PDF, cada linha é comparada com as transações existentes da mesma
conta/cartão, numa janela de ±3 dias:

| Situação | Classificação | O que acontece |
|---|---|---|
| Mesmo valor, data próxima, descrição semelhante | **correspondente** | Vincula, sem criar nada |
| Valor diferente com descrição muito parecida | **divergente** | Mostra a diferença para decidir |
| Sem correspondência | **não registrada** | Sugere criar o lançamento |
| Linha repetida no próprio arquivo ou já importada | **duplicada** | Ignorada |
| Pagamento de fatura no extrato bancário | **pagamento de fatura** | Vira `CARD_PAYMENT`, não despesa |

Nada é gravado antes de a pessoa revisar a prévia e confirmar. Cada lote pode ser desfeito.

### 10.1 Investimentos e contas próprias

Aplicação e resgate de investimento (CDB, RDB, LCI/LCA, Tesouro, poupança, fundos, previdência,
caixinhas/cofrinhos) e transferências "mesma titularidade" são **transferências**, não receita nem
despesa — no extrato importado, no WhatsApp e na correção do que já foi importado:

| Linha do extrato da conta | Vira |
|---|---|
| "RESGATE CDB" (entrada) | Transferência da conta de investimento → conta do extrato |
| "APLICACAO RDB" (saída) | Transferência da conta do extrato → conta de investimento |
| "RENDIMENTO POUPANCA", juros, dividendos | Receita (ganho de verdade) |
| "IOF/IR RESGATE", tarifas, custódia | Despesa |

- **Conta do outro lado:** regra aprendida da família; senão, a única conta de investimento/poupança
  compatível (considerando o nome citado na descrição, poupança × investimento e a mesma instituição).
  Na dúvida, ou sem conta de investimento cadastrada, a linha fica **desmarcada** com o aviso para
  escolher (ou criar) a conta — nada é presumido.
- **Na prévia:** qualquer linha pode virar transferência (ou voltar a receita/despesa), escolhendo a
  outra conta, também para as linhas parecidas do arquivo; "lembrar" cria uma regra (Categorias →
  Regras) que vale para as próximas importações.
- **Já registrado como receita/despesa** (ex.: resgate anotado pelo WhatsApp): a linha do extrato
  corresponde ao lançamento e, na confirmação, ele é **convertido** em transferência (o desfazer da
  importação reverte a conversão).
- **Extrato das duas contas** (corrente e CDB): a mesma aplicação entra uma vez só.
- **O que já foi importado errado:** em Lançamentos, "Converter em transferência" (seleção múltipla)
  mostra antes o plano e converte. Se o outro lado do movimento também estiver registrado na conta
  escolhida (ex.: a saída no extrato do CDB), ele é **unido** à transferência — excluído de forma
  restaurável e auditada — para não contar duas vezes. Regras de transferência também podem ser
  aplicadas a lançamentos anteriores.

### 10.2 Rendimento automático de investimentos

Contas de investimento/poupança podem ter rendimento automático: indexador (CDI, Selic, IPCA+ ou
prefixado), taxa (ex.: 101,5% do CDI) e data de início.

- O worker busca as taxas oficiais no Banco Central (API pública SGS: CDI série 12, Selic 11, IPCA
  433), a cada 3 horas. Nada da família é enviado. Com o BCB fora do ar, a apuração usa as taxas já
  guardadas e tenta de novo na próxima execução.
- O rendimento é calculado dia útil a dia útil sobre o saldo do fim do dia anterior (aplicações e
  resgates contam a partir do dia seguinte) e composto. Os dias úteis são os dias com CDI publicado.
- Cada mês vira **uma** receita em Investimentos › Rendimentos (bruta), criada ou ajustada a cada
  execução — nunca duplicada. Se alguém excluir o rendimento de um mês, ele não é recriado.
- A tela da conta mostra o bruto e uma **estimativa** do líquido (IR regressivo 22,5/20/17,5/15% pelo
  prazo, IOF nos primeiros 30 dias; poupança/LCI/LCA isentas). É estimativa: o valor real depende das
  datas de cada aplicação no banco.
- "Ajustar ao saldo do banco" lança a diferença como ajuste (não é receita nem despesa).

### 10.3 PDF e importação em massa

- **PDF com texto** (exportado pelo app/site do banco) é lido localmente, sem IA: linhas com data e
  valor viram lançamentos; saldos, totais, limites, resumos e valores em dólar são ignorados. Há
  leitura específica para os layouts mais comuns de Nubank, Itaú, Bradesco, Banco do Brasil, Caixa,
  Santander, Inter e C6 (colunas Valor/Saldo, Débito/Crédito, Entradas/Saídas, marcação D/C, dia por
  extenso). Quando o sinal não aparece no PDF, entrada/saída é deduzida pela descrição e a prévia avisa.
- **Fatura × extrato:** o tipo é identificado pelo conteúdo. Se não bate com o destino escolhido
  (fatura enviada para uma conta, por exemplo), a prévia mostra o aviso e **nenhuma linha fica
  selecionada** — valor de cartão nunca vira movimentação de caixa por engano.
- **Destino automático:** sem conta/cartão escolhido, o sistema usa a conta (extrato) ou o cartão
  (fatura) do banco identificado, **somente** se houver uma única opção compatível.
- **PDF digitalizado** (sem texto): só a IA consegue ler, e apenas se a família autorizou o envio de
  imagens/documentos. O resultado vai para a mesma prévia, marcado como "lido pela IA".
- **PDF com senha:** o sistema pede o arquivo sem senha; a senha nunca é pedida nem guardada.
- **Vários arquivos de uma vez** (site ou WhatsApp): cada arquivo tem a sua prévia e "confirmar
  todos" confirma em sequência. Na confirmação de cada arquivo, as linhas que outro arquivo acabou de
  importar (mesma conta/cartão: mesmo identificador/linha, ou mesma data e valor de um lançamento
  importado depois da prévia) viram **duplicadas** e não entram de novo. A prévia já avisa quando outra
  prévia pendente tem as mesmas linhas.
- Limites: 15 MB por arquivo, 5.000 lançamentos por arquivo, 60 páginas por PDF e 20 arquivos por
  confirmação em massa.

## 11. Indicadores do painel

| Indicador | Regra |
|---|---|
| Receitas / despesas do período | Transações confirmadas `INCOME`/`EXPENSE` no regime escolhido. Transferências, pagamentos de fatura e ajustes ficam de fora. |
| Saldo das contas | Soma dos movimentos de caixa até hoje (contas arquivadas e privadas de outros membros ficam de fora). |
| Faturas em aberto | Parcelas das faturas não pagas. |
| Comparativos ("18% a mais com mercado") | Período atual × período anterior equivalente, com os dois valores e a fórmula exibidos. |
| Gastos atípicos | Lançamento acima de 2× a média **e** de média + 2,5 desvios-padrão da categoria nos 6 meses anteriores. Exige pelo menos 5 lançamentos anteriores da categoria; com menos histórico, o sistema não faz afirmações. |
| Projeção de fluxo de caixa | Saldo atual + receitas previstas − despesas previstas − faturas/parcelas a vencer − recorrências. Exibe as hipóteses, as datas e a incerteza. |

## 12. Visibilidade

Contas e cartões podem ser **compartilhados** (padrão) ou **privados**. Cada membro vê apenas as suas
contas e cartões privados e as transações ligadas a eles. A exceção é quem recebeu a permissão
explícita "ver privados de outros membros". Os totais da família respeitam essa visibilidade.
