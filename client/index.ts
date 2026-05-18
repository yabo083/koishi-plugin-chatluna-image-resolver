import { Context } from '@koishijs/client'
import ImageResolverDetails from './ImageResolverDetails.vue'
import MediaCachePage from './MediaCachePage.vue'

export default (ctx: Context) => {
  ctx.slot({
    type: 'plugin-details',
    component: ImageResolverDetails,
    order: -650,
  })

  ctx.page({
    name: '媒体缓存',
    path: '/chatluna-media-cache',
    component: MediaCachePage,
    authority: 1,
  })
}
