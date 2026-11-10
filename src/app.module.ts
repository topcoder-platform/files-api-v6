import { UploadControls } from './upload-controls';
import { Module } from '@nestjs/common';
import { MemberGuard } from './auth';
import { UploadsController } from './uploads.controller';
import { UploadsService } from './uploads.service';

@Module({
  controllers: [UploadsController],
  providers: [UploadsService, MemberGuard, UploadControls],
})
export class AppModule {}
