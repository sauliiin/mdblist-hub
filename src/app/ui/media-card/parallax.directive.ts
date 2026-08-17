import { Directive, ElementRef, HostListener, inject, Renderer2 } from '@angular/core';

@Directive({
  selector: '[appParallaxCard]',
  standalone: true
})
export class ParallaxCardDirective {
  private el = inject(ElementRef);
  private renderer = inject(Renderer2);
  
  private maxRotate = 10; // Max rotation degrees
  private maxGlare = 0.8; // Max glare opacity

  @HostListener('mousemove', ['$event'])
  onMouseMove(event: MouseEvent) {
    if (window.matchMedia('(pointer: coarse)').matches) {
      return; // Disable on touch devices
    }

    const rect = this.el.nativeElement.getBoundingClientRect();
    const x = event.clientX - rect.left; // x position within the element
    const y = event.clientY - rect.top; // y position within the element
    
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    
    const rotateX = ((y - centerY) / centerY) * -this.maxRotate;
    const rotateY = ((x - centerX) / centerX) * this.maxRotate;
    
    // Calculate glare position
    const glareX = (x / rect.width) * 100;
    const glareY = (y / rect.height) * 100;

    this.renderer.setStyle(
      this.el.nativeElement, 
      'transform', 
      `perspective(1000px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`
    );
    
    this.renderer.setStyle(this.el.nativeElement, '--glare-x', `${glareX}%`);
    this.renderer.setStyle(this.el.nativeElement, '--glare-y', `${glareY}%`);
    this.renderer.setStyle(this.el.nativeElement, '--glare-opacity', this.maxGlare.toString());
  }

  @HostListener('mouseleave')
  onMouseLeave() {
    this.renderer.setStyle(this.el.nativeElement, 'transform', 'perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)');
    this.renderer.setStyle(this.el.nativeElement, '--glare-opacity', '0');
  }
}
