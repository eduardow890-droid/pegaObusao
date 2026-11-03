# Ônibus do Rio ao vivo

Mapa com a posição em tempo real dos ônibus do Rio:
dados abertos da Prefeitura + OpenStreetMap + MapLibre.

## Como rodar

1. Instale o Node.js 18 ou mais novo (nodejs.org).
2. Na pasta do projeto, rode:

   ```
   node server.js
   ```

3. Abra http://localhost:3001, digite uma linha (ex.: 485) e clique em Ver.

### Testar no celular na mesma rede

1. Conecte o celular e o computador à mesma rede Wi-Fi.
2. Inicie o servidor com `npm run start:rede`.
3. O terminal mostrará um endereço como `http://192.168.0.10:3001`.
4. Abra esse endereço no navegador do celular.

Se a página não abrir, permita a porta 3001 no firewall do computador. A localização
do celular pode ser bloqueada em HTTP usando um endereço da rede; para testar o mapa,
linha e sentidos isso não é necessário. Para usar geolocalização no celular, publique
com HTTPS ou use um túnel HTTPS de desenvolvimento.

Para executar os testes automatizados, rode `npm test`.

Para validar apenas a sintaxe, rode `npm run check`.

## Execução em produção

O projeto pode ser executado diretamente com Node.js:

```
npm install
npm start
```

Em produção, use um servidor com Node.js 18 ou mais recente, HTTPS, um domínio próprio
e um provedor de tiles com cota adequada ao volume do projeto. As variáveis de ambiente
disponíveis estão documentadas em `.env.example`.

`/healthz` expõe somente o estado geral para monitoramento externo. `/metrics` exige
`Authorization: Bearer $METRICS_TOKEN`; configure um token forte antes de consultar as métricas.

O endpoint de GPS possui rate limiting por IP. Os valores padrão são 60 consultas por minuto;
podem ser ajustados com `RATE_LIMIT_MAX` e `RATE_LIMIT_WINDOW_MS`.
Atrás de um proxy confiável, defina `TRUST_PROXY=true` para usar o primeiro endereço de
`X-Forwarded-For`; mantenha `false` quando a aplicação estiver exposta diretamente.
O acesso à SMTR usa até duas tentativas e 15 segundos por chamada; ajuste com `GPS_TIMEOUT_MS`
se o provedor de hospedagem tiver latência maior.
O navegador aguarda até 35 segundos pela resposta do GPS para não cancelar a segunda tentativa do servidor.

## API usada

A API antiga (`dados.mobilidade.rio/gps/sppo`) foi descontinuada e será desligada até 30/11/2026.
Este projeto usa a nova API da SMTR: `https://its.mobilidade.rio/v1/geolocalizacao/veiculos`
(documentação em https://its.mobilidade.rio/docs).

Ela trabalha com minutos UTC (`minuto_utc`), aceita filtro por `servico` (a linha) e devolve
`next_cursor` quando há mais páginas. O `lib.js` consulta o minuto atual e o anterior, segue as páginas
e fica com a posição mais recente de cada ônibus. A resposta da aplicação é normalizada para o contrato
`{ linha, total, atualizadoEm, onibus }`, consumido pelo mapa em `public/index.html`.

## Recursos de localização e rotas

- `/api/endereco?q=...`: busca endereços usando Nominatim/OpenStreetMap.
- `POST /api/paradas` com JSON `{ "lat": ..., "lng": ..., "raio": 800 }`: busca primeiro as paradas locais do GTFS e usa o OpenStreetMap como fallback.
- `POST /api/rota` com JSON contendo `origem` e `destino` (`lat`/`lng`): calcula rota aproximada por vias usando OSRM.
- `/api/linha?linha=485`: retorna sentidos, paradas e rota oficial importados do GTFS.
- `/api/previsao?linha=485&variante=0`: retorna previsão aproximada por parada.
- `POST /api/chegada?linha=485&variante=0` com JSON `{ "lat": -22.9, "lng": -43.2 }`: estima a chegada baseada no shape e GPS recente; exige GTFS e localização aproximada.

Depois de atualizar os arquivos em `data/gtfs/`, regenere os dados com:

```
npm run importar-gtfs
```

O feed deve ser obtido no portal oficial de dados abertos da SMTR/Prefeitura:
https://transportes.prefeitura.rio/ (seção de dados abertos/GTFS). Copie a URL de download
publicada pela SMTR para `GTFS_URL`; o portal pode alterar o endereço direto do arquivo.
Para baixar e importar automaticamente, defina `GTFS_URL` e execute:

```
GTFS_URL="https://endereco-do-gtfs/arquivo.zip" npm run atualizar-gtfs
```

O importador considera `calendar.txt` e `calendar_dates.txt`. Para reproduzir uma data específica
durante testes, use `GTFS_DATE=20261020 npm run importar-gtfs`. A data automática usa o fuso de
São Paulo, evitando virar o dia às 21h. O endpoint `/healthz` informa se os
dados GTFS estão disponíveis e a data usada na importação.
Por padrão, o importador inclui a união dos serviços válidos no período do feed (`GTFS_ALL_DAYS=1`),
evitando que uma variante de fim de semana desapareça. Use `GTFS_ALL_DAYS=0` para importar somente
o dia de `GTFS_DATE`.

O backend considera ativo somente o ônibus cuja posição tenha sido recebida dentro do limite
`MAX_IDADE_ONIBUS_MS` (padrão: 3 minutos). Também valida a caixa geográfica do Rio, timestamps,
velocidade e saltos entre leituras; os descartes aparecem em `/metrics`. Posições usadas após
falha da API são marcadas como desatualizadas e incluem sua idade. Ônibus parado ou sem velocidade
confiável não recebe uma ETA numérica. Quando há localização, a interface compara a caminhada
estimada a 1,2 m/s com a faixa prevista do ônibus.

A rota de planejamento A-B continua sendo geográfica e não representa uma rota de transporte público. A interface informa explicitamente que o tempo é estimado para carro.
A previsão por parada é aproximada, usa a posição atual do GPS e velocidade do veículo, e não considera
trânsito ou tempo parado. A localização aproximada é enviada ao backend por POST para calcular a ETA e não é persistida pela aplicação. Para uma previsão oficial, será necessário integrar GTFS-Realtime da SMTR.
No mapa, posições de ônibus a até 300 m do shape da variante são projetadas sobre o trajeto; pontos mais distantes são ocultados e informados no status, pois podem indicar GPS incorreto ou shape desatualizado. O zoom não altera as coordenadas, apenas torna mais visível a diferença entre o GPS bruto e a rota.

Se a API mudar seu contrato, a validação em `lib.js` falha com erro em vez de tratar uma resposta inválida
como se não houvesse ônibus. A paginação também falha explicitamente se ultrapassar o limite de segurança.

Para trocar o endereço sem mexer no código:

```
GPS_URL="https://endereco-atual" node server.js
```

## Estrutura

- `lib.js`: acesso à API da SMTR (minuto UTC, paginação, timeout, validação)
- `server.js`: cache limitado a 100 linhas por 15 s, coalescência de consultas simultâneas e rota `/api/onibus?linha=XXX`
- `test/`: testes automatizados (`npm test`) e exemplos de resposta em `test/fixtures/`
- `gtfs.js`: leitura dos dados compactos de linhas, paradas e rotas
- `scripts/importar-gtfs.js`: conversão do GTFS bruto
- `scripts/atualizar-gtfs.js`: download e conversão automatizados
- `scripts/gtfs-lock.js`: bloqueio contra downloads/importações simultâneos
- `public/index.html`: mapa e busca de linha
- `public/map-match.js`: projeção e ajuste visual dos ônibus sobre o shape GTFS
- `public/manifest.json` e `public/sw.js`: instalação e cache básico como PWA

## Organização e manutenção

O CSS e o JavaScript do mapa ficam separados em `public/styles.css` e `public/app.js`.
Os testes de integração usam `test/server.test.js`, enquanto `test/gtfs.test.js` valida uma
linha real importada. Para atualizar a base automaticamente, configure `GTFS_URL` e use
`npm run atualizar-gtfs`; em servidor Linux, esse comando pode ser agendado por cron.

Também é possível manter um processo agendador ativo:

```
GTFS_URL="https://endereco-do-gtfs/arquivo.zip" npm run agendar-gtfs
```

O intervalo padrão é de 7 dias e pode ser alterado com `GTFS_UPDATE_INTERVAL_MS`. O agendador
não sobrepõe importações: o bloqueio é compartilhado entre o download/importação e a execução
manual de `npm run importar-gtfs`. `data/gtfs-meta.json` registra o último download bem-sucedido,
a última tentativa e seu resultado.

Configure endpoints sem alterar o código usando `NOMINATIM_URL`, `OVERPASS_URL`, `OSRM_URL` e
`MAP_TILES_URL` (ver `.env.example`). Em produção, `CONTATO_APP` precisa ser um contato real para
o User-Agent do Nominatim; o servidor falha ao iniciar se o valor estiver ausente ou for o exemplo.

Ainda é necessário integrar GTFS-Realtime para associar veículos a viagens sem heurística,
e usar Redis caso o projeto rode em mais de uma instância.

O cálculo de chegada assume que a ordem das coordenadas em `shapes.txt` representa o sentido
do trajeto e que `velocidade` do GPS está em km/h. **CONFIRMAR COM DADOS REAIS**: o contrato
da SMTR nem sempre informa `tripId`/sentido no GPS; por isso o primeiro enquadramento usa
trajeto, distância e leituras consecutivas como conferência. A precisão melhora quando a API
passar a fornecer a viagem GTFS-Realtime do veículo.

Observação: os tiles públicos do OpenStreetMap servem para testes e uso leve.
Se o app crescer, use um provedor de tiles próprio ou gratuito com cota (ex.: MapTiler).
