import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class AuthService {
  private readonly authServiceUrl = process.env.AUTH_SERVICE_URL;

  async validateToken(token: string) {
    try {
      const response = await axios.get(`${this.authServiceUrl}/api/auth/validate`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      throw new HttpException('Invalid token', HttpStatus.UNAUTHORIZED);
    }
  }

  async getUserInfo(token: string) {
    try {
      const response = await axios.get(`${this.authServiceUrl}/api/auth/profile`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }
  }

  // Consumir información de usuarios desde Authoriza
  async getUsers(token: string, page = 1, limit = 10) {
    try {
      const response = await axios.get(`${this.authServiceUrl}/api/users?page=${page}&limit=${limit}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      throw new HttpException('Error fetching users', HttpStatus.BAD_REQUEST);
    }
  }

  // Verificar permisos de usuario para Factonet
  async checkUserAccess(token: string, userId: string) {
    try {
      const response = await axios.get(`${this.authServiceUrl}/api/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
    }
  }

  // Obtener aplicaciones disponibles
  async getApplications(token: string) {
    try {
      const response = await axios.get(`${this.authServiceUrl}/api/applications`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      throw new HttpException('Error fetching applications', HttpStatus.BAD_REQUEST);
    }
  }

  // Cambiar contraseña
  async changePassword(token: string, userId: string, oldPassword: string, newPassword: string) {
    try {
      const response = await axios.post(`${this.authServiceUrl}/api/users/${userId}/change-password`, {
        oldPassword,
        newPassword
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.data;
    } catch (error) {
      throw new HttpException('Error changing password', HttpStatus.BAD_REQUEST);
    }
  }
}