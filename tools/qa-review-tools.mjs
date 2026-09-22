export async function selectReviewState(page, state) {
  await page.getByRole('button', {name:/账号菜单/}).click();
  await page.getByRole('menuitem', {name:'体验工具',exact:true}).click();
  await page.getByRole('dialog',{name:'体验工具'}).getByRole('button',{name:state,exact:true}).click();
  await page.keyboard.press('Escape');
}
