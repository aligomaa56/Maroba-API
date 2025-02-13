import { redisClient } from '../config/redis.config.js';
import logger from '../middleware/logger.middleware.js';

export class CacheService {
  static async get(key) {
    if (!this.#isConnected()) return null;

    try {
      return await redisClient.get(key);
    } catch (error) {
      this.#handleError('get', error);
      return null;
    }
  }

  static async set(key, value, ttl = null) {
    if (!this.#isConnected()) return;

    try {
      const options = ttl ? { EX: ttl } : undefined;
      await redisClient.set(key, value, options);
    } catch (error) {
      this.#handleError('set', error);
    }
  }

  static async delete(key) {
    if (!this.#isConnected()) return;

    try {
      await redisClient.del(key);
    } catch (error) {
      this.#handleError('delete', error);
    }
  }

  static async exists(key) {
    if (!this.#isConnected()) return false;

    try {
      const result = await redisClient.exists(key);
      return result === 1;
    } catch (error) {
      this.#handleError('exists', error);
      return false;
    }
  }

  static async getWithFallback(key, fallback, ttl = 3600) {
    try {
      const cached = await this.get(key);
      if (cached) return JSON.parse(cached);
      
      const data = await fallback();
      await this.set(key, JSON.stringify(data), ttl);
      return data;
    } catch (error) {
      logger.warn(`Cache fallback triggered: ${error.message}`);
      return fallback();
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