import { Injectable } from '@angular/core';

import { User } from '../models/user.model';
import { BaseRepository } from './base.repository';

/**
 * Acceso a las cuentas guardadas en este navegador.
 *
 * Se conservan varias cuentas para poder alternar entre ellas sin volver a
 * escribir credenciales, igual que en la app móvil. La activa es la que tiene
 * `Session = '1'`, y **solo puede haber una**: esa invariante se garantiza aquí
 * y en ningún otro lugar.
 */
@Injectable({ providedIn: 'root' })
export class UserRepository extends BaseRepository<User> {
  protected readonly storeName = 'Users';

  /** La cuenta con sesión abierta. `null` si nadie ha iniciado sesión. */
  async getActiveSession(): Promise<User | null> {
    return this.getByIndex('bySession', '1');
  }

  /** Busca por usuario de acceso. La comparación es en minúsculas. */
  async findByLogin(login: string): Promise<User | null> {
    return this.getByIndex('byLogin', login.trim().toLowerCase());
  }

  /** Todas las cuentas guardadas, ordenadas por nombre. */
  async listAccounts(): Promise<User[]> {
    const users = await this.getAll();
    return users.sort((a, b) =>
      `${a.FirstName} ${a.LastName}`.localeCompare(`${b.FirstName} ${b.LastName}`),
    );
  }

  /**
   * Guarda la cuenta tras un login correcto y la deja como sesión activa.
   *
   * Si el usuario ya existía se actualiza conservando su `ID` local, para no
   * dejar huérfanos los datos que cuelgan de él.
   *
   * Devuelve el usuario tal como quedó guardado.
   */
  async upsertAndActivate(user: User): Promise<User> {
    const login = user.Login.trim().toLowerCase();
    const existing = await this.findByLogin(login);

    // Solo una sesión activa: se apagan todas antes de encender la nueva.
    await this.clearAllSessions();

    const toSave: User = {
      ...existing,
      ...user,
      Login: login,
      Session: '1',
      // Un login exitoso implica que la cuenta está activa en Visitrack.
      Active: user.Active ?? '1',
    };

    // Conservar el ID local del registro existente para no duplicarlo.
    if (existing?.ID !== undefined) toSave.ID = existing.ID;

    const key = await this.put(toSave);
    return { ...toSave, ID: toSave.ID ?? (key as number) };
  }

  /** Apaga la marca de sesión en todas las cuentas. */
  async clearAllSessions(): Promise<void> {
    const users = await this.getAll();
    const active = users.filter((u) => u.Session === '1');
    if (active.length === 0) return;

    await this.putMany(active.map((u) => ({ ...u, Session: '0' })));
  }

  /** Cierra la sesión actual sin borrar la cuenta ni sus datos. */
  async closeSession(): Promise<void> {
    await this.clearAllSessions();
  }

  /**
   * Reactiva una cuenta ya guardada, sin pedir credenciales.
   *
   * Solo sirve si la cuenta conserva su token; si no, hay que autenticar de
   * nuevo. Devuelve el usuario activado o `null` si no existe.
   */
  async switchTo(login: string): Promise<User | null> {
    const user = await this.findByLogin(login);
    if (!user) return null;

    await this.clearAllSessions();
    const updated: User = { ...user, Session: '1' };
    await this.put(updated);
    return updated;
  }

  /** Actualiza el token tras reautenticar. */
  async updateToken(userId: string, token: string): Promise<void> {
    const user = await this.getByIndex('byUserID', userId);
    if (!user?.ID) return;
    await this.update(user.ID, { Token: token });
  }

  /** Guarda el logo de la compañía cacheado para verlo sin conexión. */
  async updateCompanyLogo(userId: string, logo: string, hash: string): Promise<void> {
    const user = await this.getByIndex('byUserID', userId);
    if (!user?.ID) return;

    await this.update(user.ID, {
      LogoCompany: logo,
      LogoHash: hash,
      LogoCheckDate: new Date().toISOString(),
    });
  }

  /** Cambia el estado operativo del usuario (disponible, en ruta, etc.). */
  async updateStatus(userId: string, statusId: string): Promise<void> {
    const user = await this.getByIndex('byUserID', userId);
    if (!user?.ID) return;
    await this.update(user.ID, { StatusID: statusId });
  }
}
