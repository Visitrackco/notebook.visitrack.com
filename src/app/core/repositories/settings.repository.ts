import { Injectable } from '@angular/core';

import { BaseRepository } from './base.repository';

/** Fila de la tabla de ajustes. */
export interface AppSetting {
  /** Llave compuesta `"<settingKey>::<UserID>"`. */
  key: string;
  /** Clave lógica del ajuste. */
  settingKey: string;
  /** Cuenta dueña del ajuste. Vacío = ajuste del dispositivo. */
  UserID: string;
  value: string;
}

/**
 * Preferencias locales, con dos alcances.
 *
 * ## Por qué hay dos alcances
 *
 * En la app móvil los ajustes vivían en una tabla global sin usuario, y eso
 * produjo un problema real: si alguien desactivaba la opción de guardar
 * borradores, esa preferencia se le aplicaba a **cualquier otra cuenta** que
 * iniciara sesión después en el mismo dispositivo. Una persona podía perder sus
 * actividades a medias por una configuración que nunca eligió.
 *
 * Aquí se separa desde el principio:
 *
 * - **Dispositivo** (`UserID` vacío): del navegador, compartido. Tamaño de
 *   texto, tema, densidad — cosas de quien está frente a la pantalla.
 * - **Usuario** (`UserID` con valor): de esa cuenta. Cualquier preferencia que
 *   cambie el comportamiento de los datos va aquí.
 *
 * `getUserSetting` cae al valor de dispositivo cuando la cuenta todavía no
 * configuró el suyo, y a partir de que el usuario lo toca, se guarda a su
 * nombre y deja de heredarse.
 */
@Injectable({ providedIn: 'root' })
export class SettingsRepository extends BaseRepository<AppSetting> {
  protected readonly storeName = 'appSettings';

  /** Arma la llave compuesta. */
  private composeKey(settingKey: string, userId = ''): string {
    return `${settingKey}::${userId}`;
  }

  // ── Ajustes del dispositivo ────────────────────────────────────────────────

  async getDeviceSetting(settingKey: string, defaultValue = ''): Promise<string> {
    const row = await this.getByKey(this.composeKey(settingKey));
    return row?.value ?? defaultValue;
  }

  async setDeviceSetting(settingKey: string, value: string): Promise<void> {
    await this.put({
      key: this.composeKey(settingKey),
      settingKey,
      UserID: '',
      value,
    });
  }

  // ── Ajustes de la cuenta ───────────────────────────────────────────────────

  /**
   * Lee un ajuste de la cuenta indicada.
   *
   * Si esa cuenta no lo ha configurado, usa el valor de dispositivo como
   * semilla y, si tampoco existe, [defaultValue].
   */
  async getUserSetting(
    settingKey: string,
    userId: string,
    defaultValue = '',
  ): Promise<string> {
    if (userId) {
      const own = await this.getByKey(this.composeKey(settingKey, userId));
      if (own) return own.value;
    }
    return this.getDeviceSetting(settingKey, defaultValue);
  }

  /** Guarda un ajuste a nombre de la cuenta. Sin cuenta, cae al dispositivo. */
  async setUserSetting(settingKey: string, userId: string, value: string): Promise<void> {
    if (!userId) return this.setDeviceSetting(settingKey, value);

    await this.put({
      key: this.composeKey(settingKey, userId),
      settingKey,
      UserID: userId,
      value,
    });
  }

  /** Borra el ajuste de una cuenta para que vuelva a regir el valor por defecto. */
  async deleteUserSetting(settingKey: string, userId: string): Promise<void> {
    await this.delete(this.composeKey(settingKey, userId));
  }

  /** Borra todos los ajustes de una cuenta. Se usa al eliminarla del navegador. */
  async deleteAllForUser(userId: string): Promise<number> {
    return this.deleteWhere({ index: 'byUserID', range: userId });
  }

  // ── Atajos tipados ─────────────────────────────────────────────────────────

  async getBoolean(settingKey: string, userId: string, defaultValue = false): Promise<boolean> {
    const raw = await this.getUserSetting(settingKey, userId, defaultValue ? '1' : '0');
    return raw === '1' || raw === 'true';
  }

  async setBoolean(settingKey: string, userId: string, value: boolean): Promise<void> {
    await this.setUserSetting(settingKey, userId, value ? '1' : '0');
  }

  async getNumber(settingKey: string, userId: string, defaultValue: number): Promise<number> {
    const raw = await this.getUserSetting(settingKey, userId, String(defaultValue));
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : defaultValue;
  }

  async setNumber(settingKey: string, userId: string, value: number): Promise<void> {
    await this.setUserSetting(settingKey, userId, String(value));
  }
}

/** Claves de ajuste conocidas, para no repetir literales por el código. */
export const SETTING_KEYS = {
  /** 'enabled' | 'disabled' — si se conservan las actividades a medias. */
  DRAFT_MODE: 'draft_mode',
  /** Horas que sobrevive un borrador antes de limpiarse solo. */
  DRAFT_HOURS: 'draft_hours',
  /** Factor de escala del texto. Ajuste del dispositivo. */
  TEXT_SCALE: 'text_scale',
  /** 'light' | 'dark' | 'system'. Ajuste del dispositivo. */
  THEME: 'theme',
  /** Fecha ISO de la última sincronización completa. */
  LAST_SYNC: 'last_sync',
} as const;
