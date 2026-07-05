import { Global, Module } from '@nestjs/common';
import { TokenService } from './token.service';

// TokenService is used by both the global guards (registered in AppModule) and IdentityModule.
@Global()
@Module({
  providers: [TokenService],
  exports: [TokenService],
})
export class AuthModule {}
