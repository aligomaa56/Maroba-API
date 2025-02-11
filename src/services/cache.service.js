// src/services/cache.service.js
import { redisClient } from '../config/redis.config.js';
import logger from '../middleware/logger.middleware.js';

export class CacheService {
  static async get(key) {
    if (!this.#isConnected()) {
      return null;
    }

    try {
      const value = await redisClient.get(key);
      return value;
    } catch (error) {
      this.#handleError('get', error);
      throw error;
    }
  }

  static async set(key, value, ttl = null) {
    if (!this.#isConnected()) return;

    try {
      const options = ttl ? { EX: ttl } : undefined;
      await redisClient.set(key, value, options);
    } catch (error) {
      this.#handleError('set', error);
      throw error;
    }
  }

  static async delete(key) {
    if (!this.#isConnected()) return;

    try {
      await redisClient.del(key);
    } catch (error) {
      this.#handleError('delete', error);
      throw error;
    }
  }

  static async flush() {
    if (!this.#isConnected()) return;

    try {
      await redisClient.flushAll();
    } catch (error) {
      this.#handleError('flush', error);
      throw error;
    }
  }

  static async exists(key) {
    if (!this.#isConnected()) return false;

    try {
      const result = await redisClient.exists(key);
      return result === 1;
    } catch (error) {
      this.#handleError('exists', error);
      throw error;
    }
  }

  static async ttl(key) {
    if (!this.#isConnected()) return -2;

    try {
      return await redisClient.ttl(key);
    } catch (error) {
      this.#handleError('ttl', error);
      throw error;
    }
  }

  static isConnected() {
    return redisClient?.isOpen || false;
  }

  static #isConnected() {
    if (!redisClient?.isOpen) {
      logger.warn('Redis client not connected');
      return false;
    }
    return true;
  }

  static #handleError(operation, error) {
    logger.error(`Redis ${operation} operation failed:`, error);
  }
}