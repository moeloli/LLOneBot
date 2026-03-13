import { BaseAction, Schema } from '@/onebot11/action/BaseAction'
import { ActionName } from '@/onebot11/action/types'

interface Payload {
  file_set_id: string
}

interface Response {
  file_set_id: string
  share_link: string
  expire_time: number
}

export class ReShareFlashFile extends BaseAction<Payload, Response> {
  actionName = ActionName.ReShareFlashFile
  payloadSchema = Schema.object({
    file_set_id: Schema.string().required()
  })

  async _handle(payload: Payload) {
    const res = await this.ctx.ntFileApi.reshareFlashFile(payload.file_set_id)
    if (res.result !== 0) {
      throw new Error(res.result)
    }
    return {
      file_set_id: res.mergeFlashTransferResult.fileSetId,
      share_link: res.mergeFlashTransferResult.shareLink,
      expire_time: +res.mergeFlashTransferResult.expireTime,
    }
  }
}
