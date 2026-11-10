import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Redirect,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MemberGuard, MemberRequest } from './auth';
import { CreateUploadDto, SignUploadDto } from './uploads.dto';
import { UploadsService } from './uploads.service';

@Controller('uploads/files')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Post('sessions')
  @UseGuards(MemberGuard)
  create(@Body() input: CreateUploadDto, @Req() req: MemberRequest) {
    return this.uploads.create(input, req.user);
  }

  @Post('sign')
  @UseGuards(MemberGuard)
  sign(@Body() input: SignUploadDto, @Req() req: MemberRequest) {
    return this.uploads.sign(input, req.user);
  }

  @Post('multipart/:token')
  @HttpCode(200)
  @Header('Content-Type', 'application/xml')
  @Header('Cache-Control', 'no-store')
  createMultipart(@Param('token') token: string) {
    return this.uploads.createMultipart(token);
  }

  @Get(':token')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  @Redirect()
  async download(@Param('token') token: string) {
    return { url: await this.uploads.download(token), statusCode: 302 };
  }
}
