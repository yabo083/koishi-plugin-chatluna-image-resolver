import { Context } from '@koishijs/client'
import ImageResolverDetails from './ImageResolverDetails.vue'

export default (ctx: Context) => {
  ctx.slot({
    type: 'plugin-details',
    component: ImageResolverDetails,
    order: -650,
  })
}
