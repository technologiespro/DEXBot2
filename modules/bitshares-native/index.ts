'use strict';

const { createTransport, ConnectionError, AllNodesFailed, RpcError, RpcTimeoutError } = require('./transport');
const { createChainClient, createReadOnlyClient, ChainConfigError } = require('./chain_client');
const { createSubscriptionManager } = require('./subscriptions');
const { createSigningClient } = require('./signing_client');
const { createResolvers } = require('./resolvers');
const serial = require('./serial');
const ecc = require('./crypto/ecc');
const tx = require('./tx/builder');
const { GRAPHENE_CHAIN_ID, GRAPHENE_ADDRESS_PREFIX, GRAPHENE_BLOCKCHAIN_PRECISION } = require('./serial/chain_constants');

export = {
    createTransport,
    createChainClient,
    createReadOnlyClient,
    createSubscriptionManager,
    createSigningClient,
    createResolvers,

    ConnectionError,
    AllNodesFailed,
    RpcError,
    RpcTimeoutError,
    ChainConfigError,
    ...tx,

    serial,
    ecc,
    tx,

    GRAPHENE_CHAIN_ID,
    GRAPHENE_ADDRESS_PREFIX,
    GRAPHENE_BLOCKCHAIN_PRECISION,
};
