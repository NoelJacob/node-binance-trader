import io from "socket.io-client"

import env from "./env"
import logger from "../logger"
import {
    onBuySignal,
    onCloseTradedSignal,
    onSellSignal,
    onStopTradedSignal,
    onUserPayload,
    shutDown,
} from "./trader"
import {
    SignalJson,
    SignalTradedJson,
    StrategyJson,
    TradingType,
} from "./types/bva"
import BigNumber from "bignumber.js"

let socket: SocketIOClient.Socket

export function connect(): void {
    let authenticated = false
    socket = io("https://nbt-hub.herokuapp.com", {
        query: `v=${env().VERSION}&type=client&key=${env().BVA_API_KEY}`,
        autoConnect: false
    })

    socket.on("connect", () => {
        logger.info("Connected to the NBT Hub.")
        authenticated = true
    })
    socket.on("disconnect", () => logger.warn("Connection to the NBT Hub has been interrupted."))

    socket.on("connect_error", (error: any) => {
        logger.error(`Unable to connect to the NBT Hub: ${error}`)
        shutDown(error)
    })

    socket.on("error", (error: any) => {
        logger.error(`Received an error from the socket: ${error}`)
        if (!authenticated) shutDown(error)
    })

    socket.on("message", (message: string) => {
        logger.info(`Received a message: "${message}"`)
    })

    socket.on("user_payload", async (strategies: StrategyJson[]) => {
        if (logger.isSillyEnabled()) logger.silly(`Received user_payload: ${JSON.stringify(strategies)}`)
        await onUserPayload(strategies).catch(() => {
            return
        })
    })

    socket.on("buy_signal", async (signalJson: SignalJson) => {
        const timestamp = new Date()
        if (logger.isSillyEnabled()) logger.silly(`Received buy_signal: ${JSON.stringify(signalJson)}`)
        await onBuySignal(signalJson, timestamp).catch(() => {
            return
        })
    })
    socket.on("sell_signal", async (signalJson: SignalJson) => {
        const timestamp = new Date()
        if (logger.isSillyEnabled()) logger.silly(`Received sell_signal: ${JSON.stringify(signalJson)}`)
        await onSellSignal(signalJson, timestamp).catch(() => {
            return
        })
    })

    socket.on("close_traded_signal", async (signalJson: SignalJson) => {
        const timestamp = new Date()
        if (logger.isSillyEnabled()) logger.silly(`Received close_traded_signal: ${JSON.stringify(signalJson)}`)
        await onCloseTradedSignal(signalJson, timestamp).catch(() => {
            return
        })
    })
    socket.on("stop_traded_signal", async (signalJson: SignalJson) => {
        const timestamp = new Date()
        if (logger.isSillyEnabled()) logger.silly(`Received stop_traded_signal: ${JSON.stringify(signalJson)}`)
        await onStopTradedSignal(signalJson, timestamp).catch(() => {
            return
        })
    })

    logger.info("Connecting to the NBT Hub...")
    socket.open()
}

export function emitSignalTraded(
    channel: string,
    symbol: string,
    strategyId: string,
    strategyName: string,
    quantity: BigNumber,
    tradingType: TradingType
): void {
    socket.emit(channel, getSignalTradedJson(symbol, strategyId, strategyName, quantity, tradingType))
}

export function getSignalTradedJson(
    symbol: string,
    strategyId: string,
    strategyName: string,
    quantity: BigNumber,
    tradingType: TradingType
): SignalTradedJson {
    return new SignalTradedJson({
        bvaApiKey: env().BVA_API_KEY,
        quantity: quantity.toString(),
        strategyId: strategyId,
        strategyName: strategyName,
        symbol: symbol,
        tradingType: tradingType,
    })
}

const exportFunctions = {
    connect,
    emitSignalTraded,
}

export default exportFunctions
