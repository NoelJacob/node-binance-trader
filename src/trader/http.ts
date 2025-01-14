import * as http from "http"
import express from "express"

import logger, { loggerOutput } from "../logger"
import env from "./env"
import { closeTrade, deleteBalanceHistory, deleteTrade, resetVirtualBalances, setStrategyStopped, setTradeHODL, setTradeStopped, setVirtualWalletFunds, topUpBNBFloat, tradingMetaData} from "./trader"
import { Dictionary } from "ccxt"
import { ActionType, BalanceHistory, SourceType, Transaction, WalletType } from "./types/trader"
import BigNumber from "bignumber.js"
import { loadRecords } from "./apis/postgres"
import { Pages, Percent, TransactionSummary, URLs } from "./types/http"
import { PublicStrategy, Strategy, TradeOpen, PositionType, TradingType } from "./types/bva"

export default function startWebserver(): http.Server {
    const webserver = express()
    webserver.get("/", (req, res) =>
        res.send("Node Binance Trader is running.")
    )
    // Allow user to see open trades or delete a trade
    webserver.get("/trades", (req, res) => {
        if (authenticate(req, res)) {
            if (req.query.stop) {
                const tradeId = req.query.stop.toString()
                const tradeName = setTradeStopped(tradeId, true)
                if (tradeName) {
                    success(res, `${tradeName} has been stopped.`)
                } else {
                    fail(res, `No trade was found with the ID of '${tradeId}'.`)
                }
            } else if (req.query.start) {
                const tradeId = req.query.start.toString()
                const tradeName = setTradeStopped(tradeId, false)
                if (tradeName) {
                    success(res, `${tradeName} is no longer stopped and will continue to trade normally.`)
                } else {
                    fail(res, `No trade was found with the ID of '${tradeId}'.`)
                }
            } else if (req.query.hodl) {
                const tradeId = req.query.hodl.toString()
                const tradeName = setTradeHODL(tradeId, true)
                if (tradeName) {
                    success(res, `${tradeName} will only close on the next profitable signal.`)
                } else {
                    fail(res, `No trade was found with the ID of '${tradeId}'.`)
                }
            } else if (req.query.release) {
                const tradeId = req.query.release.toString()
                const tradeName = setTradeHODL(tradeId, false)
                if (tradeName) {
                    success(res, `${tradeName} is no longer set to HODL and will continue to trade normally.`)
                } else {
                    fail(res, `No trade was found with the ID of '${tradeId}'.`)
                }
            } else if (req.query.close) {
                const tradeId = req.query.close.toString()
                const tradeName = closeTrade(tradeId)
                if (tradeName) {
                    success(res, `A close request has been sent for ${tradeName}. Wait a few seconds before checking the logs.`)
                } else {
                    fail(res, `No trade was found with the ID of '${tradeId}'.`)
                }
            } else if (req.query.delete) {
                const tradeId = req.query.delete.toString()
                const tradeName = deleteTrade(tradeId)
                if (tradeName) {
                    success(res, `${tradeName} has been deleted.`)
                } else {
                    fail(res, `No trade was found with the ID of '${tradeId}'.`)
                }
            } else {
                res.send(formatHTMLTable(Pages.TRADES, tradingMetaData.tradesOpen))
            }
        }
    })
    // Allow user to see configured strategies
    webserver.get("/strategies", (req, res) => {
        if (authenticate(req, res)) {
            if (req.query.stop) {
                const stratId = req.query.stop.toString()
                const stratName = setStrategyStopped(stratId, true)
                if (stratName) {
                    success(res, `${stratName} has been stopped.`)
                } else {
                    fail(res, `No strategy was found with the ID of '${stratId}'.`)
                }
            } else if (req.query.start) {
                const stratId = req.query.start.toString()
                const stratName = setStrategyStopped(stratId, false)
                if (stratName) {
                    success(res, `${stratName} will continue to trade.`)
                } else {
                    fail(res, `No strategy was found with the ID of '${stratId}'.`)
                }
            } else if ("public" in req.query) {
                res.send(formatHTMLTable(Pages.STRATEGIES, Object.values(tradingMetaData.publicStrategies)))
            } else {
                res.send(formatHTMLTable(Pages.STRATEGIES, Object.values(tradingMetaData.strategies)))
            }
        }
    })
    // Allow user to see, reset, and change virtual balances
    webserver.get("/virtual", (req, res) => {
        if (authenticate(req, res)) {
            if (req.query.reset) {
                const value = new BigNumber(req.query.reset.toString())
                if (value.isGreaterThan(0)) {
                    setVirtualWalletFunds(value)
                } else if (req.query.reset.toString().toLowerCase() != "true") {
                    fail(res, "Invalid reset parameter.")
                    return
                }
                resetVirtualBalances()
                success(res, "Virtual balances have been reset.")
            } else {
                res.send(formatHTML(Pages.VIRTUAL, tradingMetaData.virtualBalances))
            }
        } 
    })
    // Allow user to see in memory or database log
    webserver.get("/log", async (req, res) => {
        if (authenticate(req, res)) {
            if ("db" in req.query) {
                let page = req.query.db ? Number.parseInt(req.query.db.toString()) : 1
                // Load the log from the database
                res.send(formatHTML(Pages.LOG_DB, (await loadRecords("log", page)).join("\r\n"), page))
            } else {
                // Use the memory log, exclude blank lines (i.e. the latest one)
                res.send(formatHTML(Pages.LOG_MEMORY, loggerOutput.filter(line => line).reverse().join("\r\n")))
            }
        }
    })
    // Allow user to see in memory or database transactions
    webserver.get("/trans", async (req, res) => {
        if (authenticate(req, res)) {
            if ("db" in req.query) {
                let page = req.query.db ? Number.parseInt(req.query.db.toString()) : 1
                // Load the transactions from the database
                res.send(formatHTMLTable(Pages.TRANS_DB, (await loadRecords("transaction", page)), page))
            } else if (req.query.summary) {
                const parts = req.query.summary.toString().split(":")
                const quote = parts[0].toUpperCase()
                const tradingType = parts[1] as TradingType
                const result = {
                    summary: await summariseTransactions(quote, tradingType),
                    currentTrades: tradingMetaData.tradesOpen.filter(trade => tradingMetaData.markets[trade.symbol].quote == quote && trade.tradingType == tradingType).length
                }
                res.json(result)
            } else {
                // Use the memory transactions
                res.send(formatHTMLTable(Pages.TRANS_MEMORY, tradingMetaData.transactions.slice().reverse()))
            }
        }
    })
    // Allow user to see actual PnL and daily balances for the past year, or reset balances for a coin, or top up BNB
    webserver.get("/pnl", (req, res) => {
        if (authenticate(req, res)) {
            if (req.query.reset) {
                const parts = req.query.reset.toString().split(":")
                const asset = parts[0].toUpperCase()
                const tradingTypes = deleteBalanceHistory(asset, parts[1] as TradingType)
                if (tradingTypes.length) {
                    let result = ""
                    for (let tradingType of tradingTypes) {
                        result += `${asset} ${tradingType} balance history has been reset.<br>`
                    }
                    success(res, result)
                } else {
                    fail(res, `No balance history found for ${asset}.`)
                }
            } else if (req.query.topup) {
                const parts = req.query.topup.toString().split(":")
                const asset = parts[0].toUpperCase()
                topUpBNBFloat(parts[1] as WalletType, asset).then((result) => {
                    success(res, result)
                }).catch(reason => {
                    fail(res, reason)
                })
            } else {
                const pnl: Dictionary<Dictionary<{}>> = {}
                const now = new Date()
                for (let tradingType of Object.keys(tradingMetaData.balanceHistory)) {
                    pnl[tradingType] = {}
                    for (let coin of Object.keys(tradingMetaData.balanceHistory[tradingType])) {
                        pnl[tradingType][coin] = [
                            percentageChange("Today", tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.date >= new Date(now.getFullYear(), now.getMonth(), now.getDate()))),
                            percentageChange("Seven Days", tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.date >= new Date(now.getFullYear(), now.getMonth(), now.getDate()-6))),
                            percentageChange("Thirty Days", tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.date >= new Date(now.getFullYear(), now.getMonth(), now.getDate()-29))),
                            percentageChange("180 Days", tradingMetaData.balanceHistory[tradingType][coin].filter(h => h.date >= new Date(now.getFullYear(), now.getMonth(), now.getDate()-179))),
                            percentageChange("Total", tradingMetaData.balanceHistory[tradingType][coin]),
                        ]
                    }
                }
                res.send(formatHTMLTable(Pages.PNL, {"Profit and Loss": pnl, "Balance History": tradingMetaData.balanceHistory}))
            }
        }
    })
    // Allow static files from the http folders
    webserver.use(express.static(__dirname + '/http'))
    // Open the web server port
    return webserver.listen(env().TRADER_PORT, () =>
        logger.info(`Webserver started on port ${env().TRADER_PORT}.`)
    )
}

function success(res: any, message: string) {
    res.send(`<font color="green">${message}</font>`)
}

function fail(res: any, message: string) {
    res.send(`<font color="red">${message}</font>`)
}

function authenticate(req: any, res: any): boolean {
    if (env().WEB_PASSWORD) {
        if (env().WEB_PASSWORD in req.query) return true

        if (Object.values(req.query).includes(env().WEB_PASSWORD)) return true
        
        logger.error("Unauthorised access request on webserver: " + req.url)

        res.send("Unauthorised.")
        return false
    }

    return true
}

function formatHTML(page: Pages, data: any, current?: number): string {
    let html = `<html><head><title>NBT: ${page.replace("<br />", " ")}</title>`
    html += `<meta name="robots" content="noindex">`
    html += `<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">`
    html += `<link rel="stylesheet" href="css/main.css">`
    html += `</head><body>`

    if (page) {
        // Menu
        html += `<p id="menu">`
        html += Object.values(Pages).map(name => {
            let link = `<button `
            if (page != name) {
                link += `onclick="location.href='${URLs[name].replace("%d", "1")}${env().WEB_PASSWORD}';"`
            } else {
                link += `class="disabled"`
            }
            link += `>${name}</button>`
            return link
        }).join(" ")
        html += `<br><label id="timestamp">${new Date().toLocaleString()}</label>`
        html += `</p>`
    }

    // Commands
    html += makeCommands(page, undefined)

    // Content
    if (data) {
        html += `<pre><code>${typeof data == "string" ? data : JSON.stringify(data, null, 4)}</code></pre>`

        // Pagination
        if (page && current) {
            html += `<div id="pages">`
            html += pageButton(page, current, false, false) + " "
            html += pageButton(page, current, true, false)
            html += `</div>`
        }
    } else {
        html += "No data yet."
        if (current) {
            html += `<div id="pages">`
            html += pageButton(page, current, false, false) + " "
            html += pageButton(page, current, true, true)
            html += `</div>`
        }
    }
    
    return html + `</body></html>`
}

function pageButton(page: Pages, current: number, next: boolean, disabled: boolean): string {
    let button = `<button `
    const num = next ? current+1 : current-1
    if (disabled || num <= 0) {
        button += `class="disabled"`
    } else {
        button += `onclick="location.href='${URLs[page].replace("%d", num.toString())}${env().WEB_PASSWORD}';"`
    }
    button += ">" + (next ? ">" : "<") + "</button>"
    return button
}

function formatHTMLTable(page: Pages, data: any, current?: number, breadcrumb?: string): string {
    let result = ""

    // Just in case
    if (!data) return result

    if (!Array.isArray(data)) {
        if (!breadcrumb) breadcrumb = ""
        for (let section of Object.keys(data)) {
            result += formatHTMLTable(page, data[section], current, breadcrumb + section + " : ")
        }
    } else {
        if (data.length) {
            const cols = new Set<string>()
            const valueSets: { [col: string] : Set<string> } = {}
            for (let row of data) {
                Object.keys(row).forEach(col => {
                    // Because objects may have been reloaded from the database via JSON, they lose their original properties
                    // So we need to check the entire dataset to make sure we have all possible columns
                    cols.add(col)

                    // We also want to keep the unique string values for colourising later
                    if (typeof(row[col]) == "string" && row[col]) {
                        if (!(col in valueSets)) valueSets[col] = new Set()
                        // Allow one extra so that we know it is over the limit
                        if (valueSets[col].size <= env().MAX_WEB_COLOURS) valueSets[col].add(row[col])
                    }
                })
            }

            const values: { [col: string] : string[] } = {}
            Object.keys(valueSets).forEach(col => {
                // Convert to sorted array if not over the maximum limit of values
                if (valueSets[col].size <= env().MAX_WEB_COLOURS) values[col] = [...valueSets[col]].sort()
            })

            // Add breadcrumb header with any buttons
            if (breadcrumb) result += `<div class="section"><h2>${breadcrumb}${makeCommands(page, breadcrumb)}</h2>`

            // Add table headers before first row
            result += "<table border=1 cellspacing=0><thead><tr>"
            for (let col of cols) {
                result += "<th>" + makeTitleCase(col) + "</th>"
            }
            if (hasRowCommands(page)) result += "<th></th>"
            result += "</tr></thead><tbody>"

            // Add row data
            for (let row of data) {
                result += "<tr>"
                for (let col of cols) {
                    result += "<td"
                    if (row[col] instanceof Date) {
                        // Include raw time as the tooltip
                        result += " class='timestamp' title='" + row[col].getTime() + "'>"
                        result += row[col].toLocaleString()
                    } else if (row[col] instanceof BigNumber) {
                        // Colour negative numbers as red
                        if (row[col].isLessThan(0)) result += " style='color: red;'"
                        result += ">"
                        if (row[col] != undefined) result += row[col].toFixed(env().MAX_WEB_PRECISION).replace(/\.?0+$/,"")
                    } else {
                        // Colour negative percentages as red
                        if (row[col] instanceof Percent && row[col].value.isLessThan(0)) result += " style='color: red;'"

                        // Colour true boolean values as blue
                        if (typeof(row[col]) == "boolean" && row[col]) result += " style='color: blue;'"

                        // Colour string as a gradient based on unique values (too many colours get meaningless)
                        if (typeof(row[col]) == "string" && row[col] && col in values) result += ` style='${makeColor(values[col].indexOf(row[col]), values[col].length)};'`

                        result += ">"
                        if (row[col] != undefined) result += row[col]
                    }
                    result += "</td>"
                }
                if (hasRowCommands(page)) result += "<td>" + makeCommands(page, row) + "</td>"
                result += "</tr>"
            }
            result += "</tbody></table>"
            if (breadcrumb) result += "</div>"
        }
    }
    if (!breadcrumb) {
        // This is top level, so wrap in HTML page
        return formatHTML(page, result, current)
    } else {
        return result
    }
}

function percentageChange(period: string, history: BalanceHistory[]): {} {
    if (history.length) {
        const open = history[0].openBalance
        const close = history[history.length-1].closeBalance
        const time = Date.now() - history[0].date.getTime()
        const fees = history.filter(h => h.estimatedFees).reduce((sum, current) => sum.plus(current.estimatedFees), new BigNumber(0))
        const value = close.minus(open).plus(fees) // TODO: don't subtract fees if BNB balance
        const percent = (!open.isZero()) ? new Percent(value.dividedBy(open).multipliedBy(100)) : ""
        const apr = (!open.isZero() && time) ? new Percent(value.dividedBy(open).dividedBy(time).multipliedBy(365 * 24 * 60 * 60 * 1000).multipliedBy(100)) : ""

        return {
            Period: period,
            Value: value,
            Total: percent,
            APR: apr,
        }
    }
    return {
        Period: period,
        Value: undefined,
        Total: undefined,
        APR: undefined,
    }
}

function makeColor(n: number, total: number): string {
    if (total <= 1) return ""

    // Offset to start with blue, darken a bit for readability
    return `color: hsl(${(225 + (n * (360 / total))) % 360}, 100%, 40%)`
}

function makeTitleCase(value: string): string {
    return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ').map(word => word.toLowerCase() == "id" ? "ID" : word.charAt(0).toUpperCase() + word.substring(1)).join(' ')
}

function hasRowCommands(page: Pages): boolean {
    return page == Pages.TRADES || page == Pages.STRATEGIES
}

function makeCommands(page: Pages, record: any): string {
    let commands = ""
    let root = page ? URLs[page] : ""
    if (env().WEB_PASSWORD) root += env().WEB_PASSWORD + "&"
    switch (typeof record) {
        case "object":
            // Table row buttons
            switch (page) {
                case Pages.TRADES:
                    const tradeOpen = record as TradeOpen
                    if (!tradeOpen.isHodl) {
                        commands += makeButton("HODL", `Are you sure you want to Hold On for Dear Life to trade ${tradeOpen.id} until a profitable close signal?`, `${root}hodl=${tradeOpen.id}`)
                    } else {
                        commands += makeButton("Resume", `Are you sure you want to resume trade ${tradeOpen.id}?`, `${root}release=${tradeOpen.id}`)
                    }
                    commands += " "
                    if (!tradeOpen.isStopped) {
                        commands += makeButton("Stop", `Are you sure you want to stop trade ${tradeOpen.id}?`, `${root}stop=${tradeOpen.id}`)
                    } else {
                        commands += makeButton("Resume", `Are you sure you want to resume trade ${tradeOpen.id}?`, `${root}start=${tradeOpen.id}`)
                    }
                    commands += " "
                    commands += makeButton("Close", `Are you sure you want to close trade ${tradeOpen.id}?`, `${root}close=${tradeOpen.id}`)
                    commands += " "
                    commands += makeButton("Delete", `Are you sure you want to delete trade ${tradeOpen.id}?`, `${root}delete=${tradeOpen.id}`)
                    break
                case Pages.STRATEGIES:
                    let strategy: Strategy | PublicStrategy = record as Strategy
                    if ('isActive' in record) {
                        if (!strategy.isStopped) {
                            commands += makeButton("Shut Down", `Are you sure you want to shut down strategy ${strategy.id}? Existing open trades will only close for profit. Loss Trade Run will be reset when you resume this strategy.`, `${root}stop=${strategy.id}`)
                        } else {
                            commands += makeButton("Resume", `Are you sure you want to resume strategy ${strategy.id}? Loss Trade Run will also reset.`, `${root}start=${strategy.id}`)
                        }
                    } else {
                        strategy = record as PublicStrategy
                    }
                    commands += " "
                    commands += makeButton("BVA", "", `https://bitcoinvsalts.com/strat/${strategy.id}`, "_blank")
                    break
            }
            break
        case "string":
            // Breadcrumb buttons
            switch (page) {
                case Pages.PNL:
                const crumb = record.split(" : ")
                commands += "<div>"
                if (crumb[0] == "Profit and Loss") {
                    const graph = "graph.html" + root.substr(URLs[page].length-1)
                    commands += makeButton("Graph", "", `${graph}summary=${crumb[2]}:${crumb[1]}`, "_blank")
                } else if (crumb[0] == "Balance History") {
                    commands += makeButton("Reset", `Are you sure you want to delete the ${crumb[1]} PnL and balance history for ${crumb[2]}?`, `${root}reset=${crumb[2]}:${crumb[1]}`)
                    if (env().BNB_FREE_FLOAT > 0 && crumb[1] as TradingType == TradingType.real && crumb[2] != "BNB") {
                        for (let wallet of Object.values(WalletType)) {
                            if (wallet == WalletType.MARGIN && !env().IS_TRADE_MARGIN_ENABLED) continue
                            commands += " "
                            commands += makeButton(`Top Up ${wallet} BNB`, `Are you sure you want to sell some ${crumb[2]} to buy BNB to top up the float on ${wallet}? Your float level is set to ${env().BNB_FREE_FLOAT} BNB.`, `${root}topup=${crumb[2]}:${wallet}`)
                        }
                    }
                }
                commands += "</div>"
                break
            }
            break
        case "undefined":
            // Page buttons
            switch (page) {
                case Pages.TRADES:
                    commands += "<div>"
                    commands += makeButton("BVA", "", `https://bitcoinvsalts.com/trades`, "_blank")
                    commands += "</div>"
                    break
                case Pages.STRATEGIES:
                    commands += "<div>"
                    commands += makeButton("BVA", "", `https://bitcoinvsaltcoins.com/profile`, "_blank")
                    commands += "</div>"
                    break
                case Pages.VIRTUAL:
                    commands += "<div>"
                    commands += makeButton("Reset", `Are you sure you want to reset all virtual balances and delete all virtual PnL and balance history?`, `${root}reset=true`)
                    commands += "</div>"
                    break
            }
            break
    }

    return commands
}

function makeButton(name: string, question: string, action: string, target: string="_self"): string {
    let button = `<button onclick="(function(){`
    if (question) button += `if(confirm('${question}')) `
    button += `window.open('${action}', '${target}')`
    button += `})();">${name}</button>`
    return button
}

// Load the previous transactions and extract a set period, then summarise PnL, trade counts, and trade volumes to hourly intervals 
async function summariseTransactions(quote: String, tradingType: TradingType): Promise<Dictionary<Dictionary<Dictionary<TransactionSummary>>>> {
    const results: Dictionary<Dictionary<Dictionary<TransactionSummary>>> = {}
    let done = false
    let page = 1
    let now = new Date()
    // Calculate the window for the maximum number of days to display, today counts as one
    let window = new Date(now.getFullYear(), now.getMonth(), now.getDate()-(env().MAX_WEB_GRAPH_DAYS-1))

    while (!done) {
        // Because we don't save the transaction as fields in the database, we can't query directly, so have to load a block and process it
        // Potentially this can miss a transaction if a new one comes in as it is switching pages, but hopefully it is rare in practice
        const transactions = await loadRecords("transaction", page) as Transaction[]
        page++
        if (!transactions.length) {
            // If there are no pages left, then finish
            done = true
            break
        }

        // Process all the transactions in the page
        for (const trans of transactions) {
            if (trans.timestamp >= window) {
                // Not going to summarise lending transactions
                if (trans.action == ActionType.BUY || trans.action == ActionType.SELL) {
                    // Check the parameters match the request, symbolAsset should always be a symbol for buy / sell transactions
                    if (trans.tradingType == tradingType && trans.symbolAsset.split("/")[1] == quote) {
                        // Clear the minutes, seconds, and milliseconds so that transactions are grouped by hours
                        trans.timestamp.setHours(trans.timestamp.getHours(), 0, 0, 0)

                        // Set up results object
                        if (!(trans.strategyName in results)) {
                            results[trans.strategyName] = {}
                        }
                        if (!(trans.positionType in results[trans.strategyName])) {
                            results[trans.strategyName][trans.positionType] = {}
                        }
                        if (!(trans.timestamp.getTime() in results[trans.strategyName][trans.positionType])) {
                            results[trans.strategyName][trans.positionType][trans.timestamp.getTime()] = new TransactionSummary()
                        }
                        
                        // Extract statistics for the summary
                        const summary = results[trans.strategyName][trans.positionType][trans.timestamp.getTime()]
                        switch (trans.positionType) {
                            case PositionType.SHORT:
                                if (trans.action == ActionType.SELL) {
                                    summary.opened++
                                } else {
                                    summary.closed++
                                }
                                break
                            case PositionType.LONG:
                                if (trans.action == ActionType.BUY) {
                                    summary.opened++
                                } else if (trans.source != SourceType.REBALANCE) {
                                    // Autobalancing is only selling part of the trade, so doesn't count as a close
                                    summary.closed++
                                }
                                break
                        }
                        // All buy / sell transactions should have a value anyway
                        if (trans.value) {
                            summary[trans.action] += trans.value.toNumber()
                        }
                        // All buy / sell transactions should have a profitLoss value anyway
                        if (trans.profitLoss) {
                            summary.profitLoss += trans.profitLoss.toNumber()
                        }
                    }
                }
            } else {
                // Transactions should be sorted by timestamp, so stop once we find one that is too old
                done = true
                break
            }
        }
    }

    return Promise.resolve(results)
}